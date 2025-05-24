const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const { visualizationEmitter } = require('./visualization-event-emmiter.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function initializeEventsFile() {
  try {
    await fs.writeFile(path.join(__dirname, 'events.json'), '[]', 'utf8');
    console.log('Events file initialized or overwritten.');
  } catch (error) {
    console.error('Error initializing events file:', error);
  }
}

initializeEventsFile();

const eventQueue = [];
let isProcessingQueue = false;

async function processQueue() {
  if (isProcessingQueue || eventQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;
  try {
    while (eventQueue.length > 0) {
      const event = eventQueue.shift();
      try {
        const eventsFile = await fs.readFile(path.join(__dirname, 'events.json'), 'utf8');
        let events = [];
        try {
          events = JSON.parse(eventsFile);
        } catch (parseError) {
          console.error('Error parsing events.json, resetting to empty array:', parseError);
          events = [];
        }
        events.push(event);
        await fs.writeFile(path.join(__dirname, 'events.json'), JSON.stringify(events, null, 2), 'utf8');
      } catch (error) {
        console.error('Error saving event to file:', error);
      }
    }
  } finally {
    isProcessingQueue = false;
  }

  if (eventQueue.length > 0) {
    processQueue();
  }
}

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

visualizationEmitter.on('visualizationEvent', (event) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(event));
    }
  });

  eventQueue.push(event);
  processQueue();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Visualization server running on http://localhost:${PORT}`);
});