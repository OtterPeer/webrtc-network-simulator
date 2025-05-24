const WebRTCPeer = require('./webrtc-peer.js').WebRTCPeer;
const ConnectionManager = require('./connection-manager.js').ConnectionManager;
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function runMultiplePeers(numPeers) {
  const signalingServerURL = process.env.SIGNALING_SERVER_URL;
  const token = process.env.TOKEN || '';
  const iceServers = JSON.parse(process.env.ICE_SERVERS);
  const peers = [];
  const peerInstances = [];
  console.log("here")

  // Create peers with profiles
  for (let i = 0; i < numPeers; i++) {
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
      searching: generateOneHotArray(3),
      latitude: 0,
      longitude: 0,
      x: x,
      y: y
    };
    const peer = new WebRTCPeer(profile, signalingServerURL, token, iceServers);
    await peer.init();
    peers.push({ id: peer.peerId, publicKey: peer.profile.publicKey, peerId: peer.peerId });
    peerInstances.push(peer);
  }

  // Setup ConnectionManager for each peer
  const connectionsRef = new Map();
  const pexDataChannelsRef = new Map();
  const profilesToDisplayRef = { current: [] };
  const displayedPeersRef = new Set();
  const currentSwiperIndexRef = { current: 0 };
  const blockedPeersRef = { current: new Set() };
  const setPeers = (peers) => console.log("Updated peers:", peers);
  const initiateConnection = async (peer, targetPeer) => {
    await peer.initiateConnection(targetPeer);
  };
  const notifyProfilesChange = () => console.log("Profiles changed");

  peerInstances.forEach((peerInstance, index) => {
    const connectionManager = new ConnectionManager(
      connectionsRef,
      pexDataChannelsRef,
      peerInstance.dht,
      { current: {} },
      profilesToDisplayRef,
      displayedPeersRef,
      currentSwiperIndexRef,
      blockedPeersRef,
      setPeers,
      (targetPeer) => initiateConnection(peerInstance, targetPeer),
      notifyProfilesChange
    );
    const otherPeers = peers.filter(p => p.id !== peerInstance.peerId);
    connectionManager.handleNewPeers(otherPeers);
  });

  // Simulate message passing (peer1 sends messages to peer2 and peer3)
  setTimeout(() => {
    if (peerInstances[0] && peers[1]) {
      peerInstances[0].dht.sendMessage(peers[1].id, { id: "msg1", content: `Hello from ${peers[0].id} to ${peers[1].id}` });
    }
  }, 5000);

  setTimeout(() => {
    if (peerInstances[0] && peers[2]) {
      peerInstances[0].dht.sendMessage(peers[2].id, { id: "msg2", content: `Hello from ${peers[0].id} to ${peers[2].id}` });
    }
  }, 10000);

  // Keep the process running
  return peerInstances;
}

// Helper functions (copied from webrtc-peer.js to avoid circular dependency issues)
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

// Run the simulation
const numPeers = parseInt(process.argv[2]) || 5;
runMultiplePeers(numPeers).then(peerInstances => {
  process.on('SIGINT', () => {
    peerInstances.forEach(peer => peer.disconnect());
    process.exit();
  });
}).catch(error => {
  console.error('Error running multiple peers:', error);
  process.exit(1);
});