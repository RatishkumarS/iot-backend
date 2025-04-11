// we load environment variables from the .env file
require('dotenv').config();

// getting required constants for backend connections
const express = require('express'); // nodejs framework for running the server
const http = require('http'); // for creating a server
const socketIo = require('socket.io'); // websockets connection
const mqtt = require('mqtt'); // mqtt message handling
const fs = require('fs');// for file service
const path = require('path'); // used in file reading
const cors = require('cors'); // for safe reliable connection between front-end and backend(express) and sockets
const AWS = require('aws-sdk'); // AWS SNS-email service

// initializing the server and running it in port 3001 
const app = express();
const server = http.createServer(app);

// initializing CORS-Cross origin resource sharingfor sockets connection
const io = socketIo(server, {
  cors: {
    origin: process.env['Frontend'],
    methods: ["GET", "POST"],
    credentials: true
  }
});



const port = process.env['port'];

// MQTT connection certs and auth creds
const mqtt_host = process.env['Mqtt-Host'];
const mqtt_port = parseInt(process.env['Mqtt-port'], 10);
// const client_id = (process.env['Mqtt-Client-Id'] || 'mqtt_webapp_client_random_id') + '_' + Math.floor((Math.random() * 100000) + 1);
const client_id = process.env['Mqtt-Client-Id'];
const key = fs.readFileSync(path.resolve(__dirname, process.env['Cert-Path']));
const cert = fs.readFileSync(path.resolve(__dirname, process.env['Cert-Path2']));
const ca = fs.readFileSync(path.resolve(__dirname, process.env['Cert-Path3']));

// Express setup with CORS-Cross origin resource sharing for safe resource sharing across endpoints
app.use(cors({
  origin: process.env['Frontend'],
  methods: ['GET', 'POST'],
  credentials: true
}));


app.use(express.static(path.join(__dirname, 'public')));

// setting up the MQTT connection
const mqttClient = mqtt.connect({
  host: mqtt_host,
  port: mqtt_port,
  protocol: 'mqtts',
  clientId: client_id,
  key: key,
  cert: cert,
  ca: ca
});

// grouping the topics based on (Sensing,alerts,usage_metric)
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

//triggering a mqtt on request and then subscribing to all topics mentioned in the topics list
mqttClient.on('connect', () => {
  console.log('Connected to AWS iot');
  topics.forEach((tops) => {
    mqttClient.subscribe(tops, (err) => {
      if (err) {
        console.error('Subscription error for topic:', tops, err);
      } else {
        console.log('Succcessfully subscribed to topic:', tops);
      }
    });
  });
});
// checking if there is an connection error in mqtt
mqttClient.on('error', (err) => {
  console.error('MQTT connection error:', err);
});

// AWS SNS configuration using environment variables from .env file
AWS.config.update({
  region: process.env['Aws-Reg'],
  accessKeyId: process.env['Aws-Access-Key'],
  secretAccessKey: process.env['Aws-Secret-Access-Key']
});
// setting the aws sns version and topic arn number from .env file
const sns = new AWS.SNS({ apiVersion: '2010-03-31' });
const SNS_TOPIC_ARN = process.env['Arn'];

const alertRecords = [];// for alerts records



// We declare certain constant to keep in memory the lastest readings
let newTemperature = null;
let newHumidity = null;
let newDarkness = null;
let fanStatus = null;
let lightStatus = null;
let newFanpercent = null;
let newLightpercent = null; 

// Checking for the mqtt messgae and parsing the message from each topics
mqttClient.on('message', (topic, message) => {
  const msg = message.toString().trim();
  console.log(` received [${topic}]: ${msg}`);

  // store the topic data on to a temperorary variable for in house memory
  try {
    const dataObj = JSON.parse(msg);
    if (topic === 'sensors/temperature') {
      newTemperature = parseFloat(dataObj.temperature);
      console.log(`Temperature status : ${newTemperature}`);
    } else if (topic === 'sensors/humidity') {
      newHumidity = parseFloat(dataObj.humidity);
      console.log(`Humidity status : ${newHumidity}`);
    } else if (topic === 'sensors/ldr') {
      newDarkness = parseFloat(dataObj.darkness);
      console.log(`LDR status : ${newDarkness}`);
    } else if (topic === 'sensors/fan') {
      fanStatus = dataObj.status?.toLowerCase();
      console.log(`Fan status : ${fanStatus}`);
      io.emit('fan_status', { status: fanStatus });
    } else if (topic === 'sensors/light') {
      lightStatus = dataObj.status?.toLowerCase();
      console.log(`Light status : ${lightStatus}`);
      io.emit('light_status', { status: lightStatus });
    } else if (topic === 'fan_usage_percentage') {
      newFanpercent = parseFloat(dataObj.percentage);
      console.log(`Fan usage percentage : ${newFanpercent}`);
    } else if (topic === 'light_usage_percentage') {
      newLightpercent = parseFloat(dataObj.percentage);
      console.log(`Light usage percentage : ${newLightpercent}`);
    }
  } catch (e) {
    console.warn(`JSON parsing failure ${topic}:`, e.message);
  }

  // Checking for all the Alert topics and if there is any on status from any of those topics
  if (['Alert_temp', 'Alert_humidity', 'Alert_darkness'].includes(topic)) {
    let alertStatus = '';
    try {
      const content = JSON.parse(msg);
      if (content.status) {
        alertStatus = content.status.toLowerCase();
      }
    } catch (e) {
      console.warn(`JSON parsing failure  ${topic}:`, e.message);
      alertStatus = msg.toLowerCase();
    }
    console.log(`Alert status ${topic}: ${alertStatus}`);

    if (alertStatus === 'on') {
      const datess = new Date();
      const formattedDate = datess.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
      const formattedTime = datess.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

      // getting the respective latest sensor data to save it in the alerts direcotry and show it to the user as a table
      let alertRecs = msg;
      if (topic === 'Alert_temp' && newTemperature !== null) {
        alertRecs = newTemperature;
      } else if (topic === 'Alert_humidity' && newHumidity !== null) {
        alertRecs = newHumidity;
      } else if (topic === 'Alert_darkness' && newDarkness !== null) {
        alertRecs = newDarkness;
      } else if (topic === 'fan_usage_percentage' && newFanpercent !== null) {
        alertRecs = newFanpercent;
      } else if (topic === 'light_usage_percentage' && newLightpercent !== null) {
        alertRecs = newLightpercent;
      }

      const record = {
        sensor: topic,
        value: alertRecs,
        date: formattedDate,
        time: formattedTime,
        location: process.env['Location']
      };

      alertRecords.push(record);
      console.log(' New Alert:', record);

      // setting email body for sending alerts through email via AWS sns service
      const snsParams = {
        Message: `Alert triggered: ${topic}\nValue: ${alertRecs}\nDate: ${formattedDate}\nTime: ${formattedTime}\nLocation: ${record.location}`,
        TopicArn: SNS_TOPIC_ARN
      };

      // publish the sns notification
      sns.publish(snsParams, (err, data) => {
        if (err) {
          console.error(" SNS Publish Error:", err);
        } else {
          console.log(" SNS Message Sent with the MessageId:", data.MessageId);
        }
      });

      // push the blinking status if any of the alert is on so that the frontend parses this variable to notify the user with a blink
      io.emit('alert_blink', { topic, status: 'on' });
    } else {
      console.log(`Received no "on" alert message for ${topic}: "${msg}"`);
    }
  }

  // Emit all MQTT messages to connected web clients via Socket.IO
  io.emit('mqtt_message', { topic, message: msg });
});

// Express routes for development purpose to show all alerts records
app.get('/alerts', (req, res) => {
  res.json({ alerts: alertRecords });
});

// Express routes for developent to clear all alerts 
app.post('/clear_alerts', (req, res) => {
  alertRecords.length = 0;
  res.json({ message: "Alerts cleared" });
});

// creating a WebSocket connection for control logic
io.on('connection', (socket) => {
  console.log(' WebSocket client connected');

  // waiting to receive control_update message from controls page in front-end
  socket.on('control_update', (data) => {
    console.log(' Received control update:', data);

    const controlDict = {
      fan: 'manual_status_fan',
      led: 'manual_status_led',
      control: 'status_control',
      alert_temp: 'Alert_temp',
      alert_humidity: 'Alert_humidity',
      Alert_darkness: 'Alert_darkness'
    };

    // We use Object function to create a list of keys form the controlDict and then parse them through a for loop to get the data and key seperately and publish them to AWS
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

  // gracefully disconnect the socket 
  socket.on('disconnect', () => {
    console.log('WebSocket client disconnected');
  });
});

// start the server at the desired port
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});