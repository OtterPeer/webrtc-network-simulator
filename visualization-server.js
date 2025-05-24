const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs').promises;
const { eventEmitter } = require('./webrtc-peer.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname)));

// Serve the visualization page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Initialize or overwrite events file on server start
async function initializeEventsFile() {
  try {
    await fs.writeFile(path.join(__dirname, 'events.json'), '[]', 'utf8');
    console.log('Events file initialized or overwritten.');
  } catch (error) {
    console.error('Error initializing events file:', error);
  }
}

initializeEventsFile();

// In-memory queue for events
const eventQueue = [];
let isProcessingQueue = false;

// Process the queue sequentially
async function processQueue() {
  if (isProcessingQueue || eventQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;
  try {
    while (eventQueue.length > 0) {
      const event = eventQueue.shift(); // Get the next event
      try {
        const eventsFile = await fs.readFile(path.join(__dirname, 'events.json'), 'utf8');
        let events = [];
        try {
          events = JSON.parse(eventsFile);
        } catch (parseError) {
          console.error('Error parsing events.json, resetting to empty array:', parseError);
          events = []; // Reset to empty array if corrupted
        }
        events.push(event);
        await fs.writeFile(path.join(__dirname, 'events.json'), JSON.stringify(events, null, 2), 'utf8');
        console.log('Event saved to events.json:', event);
      } catch (error) {
        console.error('Error saving event to file:', error);
      }
    }
  } finally {
    isProcessingQueue = false;
  }

  // Check if more events were added while processing
  if (eventQueue.length > 0) {
    processQueue();
  }
}

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

// Broadcast visualization events to all connected WebSocket clients and queue for saving
eventEmitter.on('visualizationEvent', (event) => {
  // Broadcast to WebSocket clients
  console.log(event)
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(event));
    }
  });

  // Add event to queue and process
  eventQueue.push(event);
  processQueue();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Visualization server running on http://localhost:${PORT}`);
});