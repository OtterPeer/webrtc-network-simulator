const { WebRTCPeer } = require('./webrtc-peer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Helper: Generate a one-hot encoded array with exactly one 1
function generateOneHotArray(length, onePosition = null) {
  const array = new Array(length).fill(0);
  const position = onePosition !== null ? onePosition : Math.floor(Math.random() * length);
  array[position] = 1;
  return array;
}

// Helper: Generate an array of length 46 with exactly 5 ones
function generateInterestsArray() {
  const length = 46;
  const numOnes = 5;
  const array = new Array(length).fill(0);
  const indices = Array.from({ length }, (_, i) => i);

  // Shuffle indices and pick the first 5
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  // Set 1s at the selected indices
  for (let i = 0; i < numOnes; i++) {
    array[indices[i]] = 1;
  }

  return array;
}

// Helper: Generate random x and y between -1 and 1 with 5 decimal places
function generateRandomXY() {
  const x = (Math.random() * 2 - 1).toFixed(5); // Random between -1 and 1
  const y = (Math.random() * 2 - 1).toFixed(5);
  return { x: parseFloat(x), y: parseFloat(y) };
}

// Helper: Select a random photo from /photos directory and encode as base64
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
    // Fallback to a placeholder URL
    return 'https://example.com/avatar.jpg';
  }
}

async function runMultiplePeers(numPeers) {
  // Load configuration from .env
  const signalingServerURL = process.env.SIGNALING_SERVER_URL;
  const token = process.env.TOKEN || '';
  const iceServers = JSON.parse(process.env.ICE_SERVERS);

  const peers = [];

  for (let i = 0; i < numPeers; i++) {
    // Generate random x and y values
    const { x, y } = generateRandomXY();

    const profile = {
      peerId: '',
      publicKey: '', // Will be set in init
      name: `Peer ${i + 1}`,
      profilePic: getRandomPhotoAsBase64(), // Random base64-encoded photo
      birthDay: 1,
      birthMonth: 1,
      birthYear: 1990,
      description: `Test peer ${i + 1}`,
      sex: generateOneHotArray(3), // [0, 1, 0] or similar
      interests: generateInterestsArray(), // 46 elements, 5 ones
      searching: generateOneHotArray(3), // [1, 0, 0] or similar
      latitude: 0,
      longitude: 0,
      x: x,
      y: y
    };

    const peer = new WebRTCPeer(profile, signalingServerURL, token, iceServers);
    await peer.init();
    peers.push(peer);
  }

  // Example: Connect peers to each other
  for (let i = 1; i < peers.length; i++) {
    const targetPeer = {
      peerId: peers[0].peerId,
      publicKey: peers[0].profile.publicKey
    };
    // await peers[i].initiateConnection(targetPeer);
  }

  // Keep process running
  process.on('SIGINT', () => {
    peers.forEach(peer => peer.disconnect());
    process.exit();
  });
}

// Get number of peers from command-line argument
const numPeersArg = process.argv[2];
const numPeers = parseInt(numPeersArg, 10);

if (isNaN(numPeers) || numPeers <= 0) {
  console.error('Please provide a valid number of peers as a command-line argument.');
  console.error('Example: node run-multiple-peers.js 5');
  process.exit(1);
}

runMultiplePeers(numPeers).catch(error => {
  console.error('Error running multiple peers:', error);
  process.exit(1);
});