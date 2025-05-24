const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const { visualizationEmitter } = require('./visualization-event-emmiter.js');
require('dotenv').config();

require('./visualization-server.js');

async function runMultiplePeers(numPeers) {
  const signalingServerURL = process.env.SIGNALING_SERVER_URL;
  const token = process.env.TOKEN || '';
  const iceServers = JSON.parse(process.env.ICE_SERVERS);
  const peers = [];
  const peerProcesses = [];
  console.log("Starting peer simulation...");

  for (let i = 0; i < numPeers; i++) {
    const { lat, lng } = generateRandomLatLng();
    const { x, y } = generateRandomXY();
    const profile = {
      publicKey: '',
      name: `Peer ${i + 1}`,
      profilePic: getRandomPhotoAsBase64(),
      birthDay: 1,
      birthMonth: 1,
      birthYear: 1990,
      description: `Test peer ${i + 1} for WebRTC`,
      sex: generateOneHotArray(3),
      interests: generateInterestsArray(),
      searching: generateOneHotArray(6),
      latitude: lat,
      longitude: lng,
      x: x,
      y: y
    };

    const peerProcess = fork(path.join(__dirname, 'peer-worker.js'));
    peerProcesses.push(peerProcess);

    peerProcess.send({
      type: 'init',
      profile,
      signalingServerURL,
      token,
      iceServers,
      peerIndex: i
    });

    await new Promise((resolve, reject) => {
      peerProcess.on('message', (msg) => {
        if (msg.type === 'peerInfo') {
          peers.push({
            id: msg.peerId,
            publicKey: msg.publicKey,
            peerId: msg.peerId,
            process: peerProcess
          });
          console.log(`Peer ${msg.peerIndex + 1} info received: ${msg.peerId}`);
          resolve();
        } else if (msg.type === 'error') {
          console.error(`Error in peer ${msg.peerIndex + 1}: ${msg.error}`);
          reject(new Error(msg.error));
        } else if (msg.type === 'ready') {
          console.log(`Peer ${msg.peerIndex + 1} is ready`);
        } else if (msg.type === 'visualizationEvent') {
          visualizationEmitter.emit('visualizationEvent', msg.event);
        }
      });

      peerProcess.on('exit', (code) => {
        console.log(`Peer process ${i + 1} exited with code ${code}`);
      });
    });
  }

  setTimeout(() => {
    if (peers[0] && peers[1]) {
      peers[0].process.send({
        type: 'sendMessage',
        recipientId: peers[1].id,
        message: { id: "msg1", senderId: peers[0].id, encryptedMessage: `Hello from ${peers[0].id} to ${peers[1].id}` }
      });
    }
  }, 5000);

  setTimeout(() => {
    if (peers[0] && peers[2]) {
      peers[0].process.send({
        type: 'sendMessage',
        recipientId: peers[2].id,
        message: { id: "msg2", senderId: peers[0].id, encryptedMessage: `Hello from ${peers[0].id} to ${peers[2].id}` }
      });
    }
  }, 10000);

  return peerProcesses;
}

function generateRandomLatLng(centerLat = 37.422, centerLng = -122.084, radiusKm = 50) {
  const earthRadius = 6371;

  const radiusRad = radiusKm / earthRadius;

  const u = Math.random();
  const v = Math.random();
  const w = radiusRad * Math.sqrt(u);
  const t = 2 * Math.PI * v;

  const centerLatRad = centerLat * Math.PI / 180;
  const centerLngRad = centerLng * Math.PI / 180;

  const newLatRad = centerLatRad + w * Math.cos(t);
  const newLngRad = centerLngRad + w * Math.sin(t) / Math.cos(centerLatRad);

  const newLat = newLatRad * 180 / Math.PI;
  const newLng = newLngRad * 180 / Math.PI;
  
  return {
    lat: parseFloat(newLat.toFixed(5)),
    lng: parseFloat(newLng.toFixed(5))
  };
}

function generateRandomXY() {
  const x = (Math.random() * 2 - 1).toFixed(5);
  const y = (Math.random() * 2 - 1).toFixed(5);
  return { x: parseFloat(x), y: parseFloat(y) };
}

function generateOneHotArray(length, onePosition = null) {
  const array = new Array(length).fill(0);
  const position = onePosition !== null ? onePosition : Math.floor(Math.random() * length);
  array[position] = 1;
  return array;
}

function generateInterestsArray() {
  const length = 46;
  const numOnes = 5;
  const array = new Array(length).fill(0);
  const indices = Array.from({ length }, (_, i) => i);
  
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  
  for (let i = 0; i < numOnes; i++) {
    array[indices[i]] = 1;
  }
  
  return array;
}

function getRandomPhotoAsBase64() {
  try {
    const photosDir = path.join(__dirname, 'photos');
    const files = fs.readdirSync(photosDir);
    const imageFiles = files.filter(file => /\.(jpg|jpeg|png)$/i.test(file));
    
    if (imageFiles.length === 0) {
      throw new Error('No image files found in /photos directory');
    }
    
    const randomImage = imageFiles[Math.floor(Math.random() * imageFiles.length)];
    const imagePath = path.join(photosDir, randomImage);
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mimeType = path.extname(randomImage).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    return `data:${mimeType};base64,${base64Image}`;
  } catch (error) {
    console.error('Error loading random photo:', error);
    return 'https://example.com/avatar.jpg';
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const numPeers = parseInt(process.argv[2]) || 5;
runMultiplePeers(numPeers).then(peerProcesses => {
  process.on('SIGINT', () => {
    console.log('Shutting down all peer processes...');
    peerProcesses.forEach(process => {
      process.send({ type: 'shutdown' });
    });
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  });
}).catch(error => {
  console.error('Error running multiple peers:', error);
  process.exit(1);
});

module.exports = { visualizationEmitter };