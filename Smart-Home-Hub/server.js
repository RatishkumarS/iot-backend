// Load environment variables from the .env file
require('dotenv').config();

// Required modules
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const AWS = require('aws-sdk');

// Initialize Express and create HTTP server
const app = express();
const server = http.createServer(app);

// Use the 'Frontend' URL from the environment variables for CORS configuration
const frontend = process.env.Frontend || "http://localhost:3001";

// Set up Socket.IO with CORS configuration
const io = socketIo(server, {
  cors: {
    origin: frontend,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Set up CORS for Express routes
app.use(cors({
  origin: frontend,
  methods: ['GET', 'POST'],
  credentials: true
}));

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Use the port from the .env file (key: port) or default to 3000
const port = process.env.port || 3000;

// MQTT configuration: using keys from the .env file
const mqtt_host = process.env['Mqtt-Host'];
const mqtt_port = parseInt(process.env['Mqtt-Port'], 10);
const client_id = process.env['Mqtt-Client-Id'];

// Read MQTT certificate files; ensure these paths are valid in your deployment
const key = fs.readFileSync(path.resolve(__dirname, process.env['Cert-Path']));
const cert = fs.readFileSync(path.resolve(__dirname, process.env['Cert-Path2']));
const ca = fs.readFileSync(path.resolve(__dirname, process.env['Cert-Path3']));

// Connect to the MQTT broker using secure MQTT (mqtts)
const mqttClient = mqtt.connect({
  host: mqtt_host,
  port: mqtt_port,
  protocol: 'mqtts',
  clientId: client_id,
  key: key,
  cert: cert,
  ca: ca
});

// Define topic groups for MQTT subscriptions
const topics = [
  [
    'sensors/temperature',
    'sensors/humidity',
    'sensors/ldr',
    'sensors/fan',
    'sensors/light'
  ],
  [
    'Alert_temp',
    'Alert_humidity',
    'Alert_darkness'
  ],
  [
    'fan_usage_percentage',
    'light_usage_percentage'
  ]
];

// Subscribe to MQTT topics when connected
mqttClient.on('connect', () => {
  console.log('Connected to AWS IoT via MQTT');
  topics.forEach((topicGroup) => {
    mqttClient.subscribe(topicGroup, (err) => {
      if (err) {
        console.error('Subscription error for topics:', topicGroup, err);
      } else {
        console.log('Successfully subscribed to topics:', topicGroup);
      }
    });
  });
});

// Log MQTT connection errors
mqttClient.on('error', (err) => {
  console.error('MQTT connection error:', err);
});

// Configure AWS SNS using environment variables from the .env file
AWS.config.update({
  region: process.env['Aws-Reg'],
  accessKeyId: process.env['Aws-Access-Key'],
  secretAccessKey: process.env['Aws-Secret-Access-Key']
});
const sns = new AWS.SNS({ apiVersion: '2010-03-31' });
const SNS_TOPIC_ARN = process.env['Arn'];

// In-memory storage for alerts and latest sensor readings
const alertRecords = [];
let newTemperature = null;
let newHumidity = null;
let newDarkness = null;
let fanStatus = null;
let lightStatus = null;
let newFanpercent = null;
let newLightpercent = null;

// Handle incoming MQTT messages
mqttClient.on('message', (topic, message) => {
  const msg = message.toString().trim();
  console.log(`Received [${topic}]: ${msg}`);

  try {
    const dataObj = JSON.parse(msg);
    if (topic === 'sensors/temperature') {
      newTemperature = parseFloat(dataObj.temperature);
      console.log(`Temperature: ${newTemperature}`);
    } else if (topic === 'sensors/humidity') {
      newHumidity = parseFloat(dataObj.humidity);
      console.log(`Humidity: ${newHumidity}`);
    } else if (topic === 'sensors/ldr') {
      newDarkness = parseFloat(dataObj.darkness);
      console.log(`LDR: ${newDarkness}`);
    } else if (topic === 'sensors/fan') {
      fanStatus = dataObj.status?.toLowerCase();
      console.log(`Fan status: ${fanStatus}`);
      io.emit('fan_status', { status: fanStatus });
    } else if (topic === 'sensors/light') {
      lightStatus = dataObj.status?.toLowerCase();
      console.log(`Light status: ${lightStatus}`);
      io.emit('light_status', { status: lightStatus });
    } else if (topic === 'fan_usage_percentage') {
      newFanpercent = parseFloat(dataObj.percentage);
      console.log(`Fan usage percentage: ${newFanpercent}`);
    } else if (topic === 'light_usage_percentage') {
      newLightpercent = parseFloat(dataObj.percentage);
      console.log(`Light usage percentage: ${newLightpercent}`);
    }
  } catch (e) {
    console.warn(`JSON parsing error for ${topic}:`, e.message);
  }

  // Process alert topics
  if (['Alert_temp', 'Alert_humidity', 'Alert_darkness'].includes(topic)) {
    let alertStatus = '';
    try {
      const content = JSON.parse(msg);
      if (content.status) {
        alertStatus = content.status.toLowerCase();
      }
    } catch (e) {
      console.warn(`JSON parsing error for alert ${topic}:`, e.message);
      alertStatus = msg.toLowerCase();
    }
    console.log(`Alert status for ${topic}: ${alertStatus}`);

    if (alertStatus === 'on') {
      const now = new Date();
      const formattedDate = now.toLocaleDateString('en-US', {
        month: '2-digit',
        day: '2-digit',
        year: 'numeric'
      });
      const formattedTime = now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });

      let alertValue = msg;
      if (topic === 'Alert_temp' && newTemperature !== null) {
        alertValue = newTemperature;
      } else if (topic === 'Alert_humidity' && newHumidity !== null) {
        alertValue = newHumidity;
      } else if (topic === 'Alert_darkness' && newDarkness !== null) {
        alertValue = newDarkness;
      } else if (topic === 'fan_usage_percentage' && newFanpercent !== null) {
        alertValue = newFanpercent;
      } else if (topic === 'light_usage_percentage' && newLightpercent !== null) {
        alertValue = newLightpercent;
      }

      const record = {
        sensor: topic,
        value: alertValue,
        date: formattedDate,
        time: formattedTime,
        location: process.env['Location']
      };

      alertRecords.push(record);
      console.log('New Alert:', record);

      const snsParams = {
        Message: `Alert triggered: ${topic}\nValue: ${alertValue}\nDate: ${formattedDate}\nTime: ${formattedTime}\nLocation: ${record.location}`,
        TopicArn: SNS_TOPIC_ARN
      };

      sns.publish(snsParams, (err, data) => {
        if (err) {
          console.error("SNS Publish Error:", err);
        } else {
          console.log("SNS Message Sent with MessageId:", data.MessageId);
        }
      });

      io.emit('alert_blink', { topic, status: 'on' });
    } else {
      console.log(`No active alert for ${topic}: "${msg}"`);
    }
  }

  // Emit all MQTT messages to web clients via Socket.IO
  io.emit('mqtt_message', { topic, message: msg });
});

// Express route to retrieve alert records
app.get('/alerts', (req, res) => {
  res.json({ alerts: alertRecords });
});

// Express route to clear alerts
app.post('/clear_alerts', (req, res) => {
  alertRecords.length = 0;
  res.json({ message: "Alerts cleared" });
});

// Socket.IO connection for control messages from the frontend
io.on('connection', (socket) => {
  console.log('WebSocket client connected');

  socket.on('control_update', (data) => {
    console.log('Received control update:', data);

    const controlDict = {
      fan: 'manual_status_fan',
      led: 'manual_status_led',
      control: 'status_control',
      alert_temp: 'Alert_temp',
      alert_humidity: 'Alert_humidity',
      Alert_darkness: 'Alert_darkness'
    };

    Object.keys(controlDict).forEach(key => {
      if (data[key] !== undefined) {
        const content = JSON.stringify(data[key]);
        const topic = controlDict[key];
        mqttClient.publish(topic, content, (err) => {
          if (err) {
            console.error(`Error publishing to ${topic}:`, err);
          } else {
            console.log(`Published ${content} to ${topic}`);
          }
        });
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('WebSocket client disconnected');
  });
});

// Start the server using the port from the .env file (or default)
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
