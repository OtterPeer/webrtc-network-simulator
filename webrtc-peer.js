const wrtc = require('@roamhq/wrtc');
const { Socket, io } = require('socket.io-client');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const DHT = require('./dht.js').default;

// In-memory store for user data (replacing userdb)
const userStore = new Map();

// In-memory store for private keys (replacing AsyncStorage)
const privateKeyStore = new Map();

// Generate RSA key pair (matching React Native's pkcs1 format)
function generateKeyPair() {
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
    });
    return { publicKey, privateKey };
  } catch (error) {
    console.error('Error generating key pair:', error);
    throw error;
  }
}

// Create SHA-1 hash for peerId
function createSHA1Hash(inputString) {
  return crypto.createHash('sha1').update(inputString).digest('hex');
}

// Derive peerId from public key
function derivePeerId(publicKey) {
  return createSHA1Hash(publicKey);
}

// Verify public key matches peerId
async function verifyPublicKey(peerId, publicKey) {
  const derivedPeerId = derivePeerId(publicKey);
  if (derivedPeerId !== peerId) {
    throw new Error(`Public key hash (${derivedPeerId}) doesn't match peerId (${peerId})`);
  }
  const user = userStore.get(peerId);
  if (!user) {
    userStore.set(peerId, { peerId, publicKey });
  }
}

// Encrypt AES key with public key
function encryptAesKey(targetPublicKey, aesKey) {
  targetPublicKey = targetPublicKey.trim();
  try {
    if (!targetPublicKey.startsWith('-----BEGIN RSA PUBLIC KEY-----') || !targetPublicKey.endsWith('-----END RSA PUBLIC KEY-----')) {
      throw new Error('Invalid public key format');
    }
    return crypto
      .publicEncrypt(
        {
          key: targetPublicKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
        },
        Buffer.from(aesKey, 'base64')
      )
      .toString('base64');
  } catch (error) {
    console.error('Error encrypting AES key:', error);
    throw error;
  }
}

// Decrypt AES key with private key
async function decryptAESKey(encryptedAesKey, selfPeerId) {
  const privateKey = privateKeyStore.get(selfPeerId);
  if (!privateKey) {
    throw new Error(`No private key found for self`);
  }
  try {
    return crypto
      .privateDecrypt(
        {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
        },
        Buffer.from(encryptedAesKey, 'base64')
      )
      .toString('base64');
  } catch (error) {
    console.error(`Error decrypting AES key:`, error);
    throw error;
  }
}

// Sign message with private key
async function signMessage(message, peerId) {
  const privateKey = privateKeyStore.get(peerId);
  if (!privateKey) {
    throw new Error(`No private key found for peer ${peerId}`);
  }
  try {
    const sign = crypto.createSign('SHA256');
    sign.update(message, 'base64');
    return sign.sign({ key: privateKey }, 'base64');
  } catch (error) {
    console.error(`Error signing message for peer ${peerId}:`, error);
    throw error;
  }
}

// Verify signature with public key
function verifySignature(encryptedAesKey, senderPublicKey, encryptedAesKeySignature) {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(encryptedAesKey, 'base64');
    const isValid = verify.verify(
      { key: senderPublicKey, encoding: 'utf-8' },
      Buffer.from(encryptedAesKeySignature, 'base64')
    );
    if (!isValid) {
      throw new Error('Signature verification failed');
    }
  } catch (error) {
    console.error('Error verifying signature:', error);
    throw error;
  }
}

// Encode and encrypt message with AES
function encodeAndEncryptMessage(message, aesKey, iv) {
  try {
    const encodedMessage = Buffer.from(message, 'utf-8').toString('base64');
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      Buffer.from(aesKey, 'base64'),
      Buffer.from(iv, 'base64')
    );
    let encryptedMessage = cipher.update(encodedMessage, 'utf8', 'base64');
    encryptedMessage += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    return { encryptedMessage, authTag };
  } catch (error) {
    console.error('Error encoding and encrypting message:', error);
    throw error;
  }
}

// Decrypt and decode message with AES
function decryptAndDecodeMessage(aesKey, iv, authTag, encryptedMessage) {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(aesKey, 'base64'),
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    let decryptedMessage = decipher.update(encryptedMessage, 'base64', 'utf8');
    decryptedMessage += decipher.final('utf8');
    return Buffer.from(decryptedMessage, 'base64').toString('utf-8');
  } catch (error) {
    console.error('Error decrypting and decoding message:', error);
    throw error;
  }
}

// Encrypt and sign offer
async function encryptAndSignOffer(senderId, targetId, sessionDescription, targetPublicKey, senderPublicKey) {
  try {
    let aesKey, iv, keyId;
    const targetUser = userStore.get(targetId);
    if (!targetUser || !targetUser.aesKey || !targetUser.iv || !targetUser.keyId) {
      aesKey = crypto.randomBytes(32).toString('base64');
      iv = crypto.randomBytes(12).toString('base64');
      keyId = uuid();
      userStore.set(targetId, {
        peerId: targetId,
        publicKey: targetPublicKey,
        aesKey,
        iv,
        keyId
      });
    } else {
      aesKey = targetUser.aesKey;
      iv = targetUser.iv;
      keyId = targetUser.keyId;
    }

    const sdp = sessionDescription.sdp;
    const { encryptedMessage, authTag } = encodeAndEncryptMessage(sdp, aesKey, iv);
    const encryptedAesKey = encryptAesKey(targetPublicKey, aesKey);
    const encryptedAesKeySignature = await signMessage(encryptedAesKey, senderId);

    return {
      encryptedOffer: encryptedMessage,
      publicKey: senderPublicKey,
      encryptedAesKey,
      iv,
      authTag,
      from: senderId,
      target: targetId,
      encryptedAesKeySignature,
      keyId
    };
  } catch (error) {
    console.error(`Error encrypting and signing offer for target ${targetId}:`, error);
    throw error;
  }
}

// Verify and decrypt offer
async function verifyAndDecryptOffer(encryptedPayload, senderPublicKey, selfPeerId) {
  try {
    const { encryptedOffer, encryptedAesKey, authTag, encryptedAesKeySignature, from, iv, keyId } = encryptedPayload;
    let aesKey;
    const senderUser = userStore.get(from);
    if (senderUser && senderUser.keyId && senderUser.keyId === keyId && senderUser.aesKey && senderUser.iv) {
      aesKey = senderUser.aesKey;
    } else {
      verifySignature(encryptedAesKey, senderPublicKey, encryptedAesKeySignature);
      aesKey = await decryptAESKey(encryptedAesKey, selfPeerId);
      userStore.set(from, {
        peerId: from,
        publicKey: senderPublicKey,
        aesKey,
        iv,
        keyId
      });
    }

    const decodedOffer = decryptAndDecodeMessage(aesKey, iv, authTag, encryptedOffer);
    return { sdp: decodedOffer, type: 'offer' };
  } catch (error) {
    console.error(`Error verifying and decrypting offer from ${encryptedPayload.from}:`, error);
    throw error;
  }
}

// Encrypt answer
async function encryptAnswer(senderId, targetId, sessionDescription, senderPublicKey) {
  try {
    const user = userStore.get(targetId);
    if (!user || !user.aesKey || !user.iv) {
      throw new Error(`No AES key or IV found for peer ${targetId}`);
    }
    const aesKey = user.aesKey;
    const iv = user.iv;

    const { encryptedMessage, authTag } = encodeAndEncryptMessage(sessionDescription.sdp, aesKey, iv);

    return {
      from: senderId,
      target: targetId,
      encryptedAnswer: encryptedMessage,
      authTag,
      publicKey: senderPublicKey
    };
  } catch (error) {
    console.error(`Error encrypting answer for target ${targetId}:`, error);
    throw error;
  }
}

// Decrypt answer
async function decryptAnswer(encryptedRTCSessionDescription) {
  try {
    const senderUser = userStore.get(encryptedRTCSessionDescription.from);
    if (!senderUser || !senderUser.aesKey || !senderUser.iv) {
      throw new Error(`No AES key or IV found for peer ${encryptedRTCSessionDescription.from}`);
    }
    const aesKey = senderUser.aesKey;
    const iv = senderUser.iv;

    console.log(aesKey);
    console.log(encryptedRTCSessionDescription);
    console.log(iv);
    console.log(encryptedRTCSessionDescription.authTag);

    const decryptedAnswer = decryptAndDecodeMessage(aesKey, iv, encryptedRTCSessionDescription.authTag, encryptedRTCSessionDescription.encryptedAnswer);
    console.log(decryptedAnswer)
    return { sdp: decryptedAnswer, type: 'answer' };
  } catch (error) {
    console.error(`Error decrypting answer from ${encryptedRTCSessionDescription.from}:`, error);
    throw error;
  }
}

// Calculate age for PeerDTO
function calculateAge(birthDay, birthMonth, birthYear) {
  try {
    const today = new Date();
    const birthDate = new Date(birthYear, birthMonth - 1, birthDay);
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
      age--;
    }
    return age;
  } catch (error) {
    console.error('Error calculating age:', error);
    return 0;
  }
}

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
  
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  
  for (let i = 0; i < numOnes; i++) {
    array[indices[i]] = 1;
  }
  
  return array;
}

// Helper: Generate random x and y between -1 and 1 with 5 decimal places
function generateRandomXY() {
  const x = (Math.random() * 2 - 1).toFixed(5);
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
    return 'https://example.com/avatar.jpg';
  }
}

// Helper: Send data in chunks
function sendData(dataChannel, fileData, chunkSize = 16384) {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    console.error('Data channel is not open.');
    return;
  }

  const totalSize = fileData.length;
  let offset = 0;

  console.log(`Sending file of size ${totalSize} in chunks of ${chunkSize} bytes.`);

  const sendChunk = () => {
    if (offset < totalSize) {
      const chunk = fileData.slice(offset, offset + chunkSize);
      dataChannel.send(chunk);
      offset += chunkSize;
      setTimeout(sendChunk, 0);
    } else {
      dataChannel.send('EOF');
      console.log('File transfer complete.');
    }
  };

  sendChunk();
}

// WebRTC Peer class
class WebRTCPeer {
  constructor(profile, signalingServerURL, token, iceServers) {
    this.profile = profile;
    this.peerId = derivePeerId(profile.publicKey);
    this.profile.peerId = this.peerId;
    this.signalingServerURL = signalingServerURL;
    this.token = token;
    this.iceServers = iceServers;
    this.connections = new Map();
    this.dataChannels = new Map();
    this.socket = null;
    this.dht = null; // DHT instance for this peer
  }

  async init() {
    const { publicKey, privateKey } = generateKeyPair();
    this.peerId = derivePeerId(publicKey);
    if (derivePeerId(publicKey) !== this.peerId) {
      throw new Error('Generated public key does not match peerId');
    }
    this.profile.publicKey = publicKey;
    this.profile.peerId = this.peerId;
    privateKeyStore.set(this.peerId, privateKey);

    userStore.set(this.peerId, {
      peerId: this.peerId,
      publicKey: this.profile.publicKey
    });

    // Initialize DHT instance for this peer
    this.dht = new DHT({ nodeId: this.peerId });
    this.dht.on('ready', () => {
      console.log(`DHT for peer ${this.peerId} is ready`);
    });

    try {
      this.socket = io(this.signalingServerURL, {
        auth: { token: this.token }
      });

      this.socket.on('connect', () => {
        console.log(`Peer ${this.peerId} connected to signaling server`);
        const readyMessage = {
          peerDto: {
            peerId: this.peerId,
            publicKey: this.profile.publicKey,
            x: this.profile.x,
            y: this.profile.y,
            sex: this.profile.sex,
            searching: this.profile.searching,
            age: calculateAge(this.profile.birthDay, this.profile.birthMonth, this.profile.birthYear),
            latitude: this.profile.latitude,
            longitude: this.profile.longitude
          },
          type: 'type-emulator'
        };
        this.socket.emit('ready', readyMessage);
      });

      this.socket.on('message', (message) => {
        if (message.target === this.peerId) {
          this.handleSignalingMessage(message);
        }
      });

      this.socket.on('disconnect', () => {
        console.log(`Peer ${this.peerId} disconnected from signaling server`);
      });
    } catch (error) {
      console.error(`Error initializing socket for peer ${this.peerId}:`, error);
      throw error;
    }
  }

  createPeerConnection(targetPeer) {
    try {
      const peerConnection = new wrtc.RTCPeerConnection({ iceServers: this.iceServers });

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          const iceCandidateMessage = {
            target: targetPeer.peerId,
            from: this.peerId,
            candidate: event.candidate
          };
          this.socket.emit('messageOne', iceCandidateMessage);
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log(`Peer ${targetPeer.peerId} ICE state: ${peerConnection.iceConnectionState}`);
        if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'closed') {
          this.closeConnection(targetPeer.peerId);
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === 'connected') {
          console.log(`Peer ${targetPeer.peerId} connected`);
        } else if (peerConnection.connectionState === 'closed') {
          this.closeConnection(targetPeer.peerId);
        }
      };

      peerConnection.ondatachannel = (event) => {
        const dataChannel = event.channel;
        this.setupDataChannel(dataChannel, targetPeer);
      };

      this.connections.set(targetPeer.peerId, peerConnection);
      return peerConnection;
    } catch (error) {
      console.error(`Error creating peer connection for ${targetPeer.peerId}:`, error);
      throw error;
    }
  }

  setupDataChannel(dataChannel, targetPeer) {
    const label = dataChannel.label;
    this.dataChannels.set(`${targetPeer.peerId}:${this.peerId}:${label}`, dataChannel);

    dataChannel.onopen = () => {
      console.log(`Data channel ${label} opened with peer ${targetPeer.peerId}`);
    };

    dataChannel.onclose = () => {
      console.log(`Data channel ${label} closed with peer ${targetPeer.peerId}`);
      this.dataChannels.delete(`${targetPeer.peerId}:${this.peerId}:${label}`);
    };

    dataChannel.onerror = (error) => {
      console.error(`Data channel ${label} error with peer ${targetPeer.peerId}:`, error);
    };

    if (label === 'profile') {
      dataChannel.onmessage = (event) => {
        if (event.data === 'request_profile') {
          console.log(`Received profile request from ${targetPeer.peerId} to peer ${this.peerId}`);
          this.sendProfile(dataChannel);
        }
      };
    } else if (label === 'peer_dto') {
      dataChannel.onmessage = (event) => {
        if (event.data === 'request_peer_dto') {
          console.log(`Received peer_dto request from ${targetPeer.peerId}`);
          this.sendPeerDTO(dataChannel, targetPeer);
        }
      };
    } else if (label === 'signaling') {
      dataChannel.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleSignalingOverDataChannels(message, targetPeer, dataChannel);
        } catch (error) {
          console.error(`Error parsing signaling message from ${targetPeer.peerId}:`, error);
        }
      };
    } else if (label === 'dht') {
      this.dht.setupDataChannel(targetPeer.peerId, dataChannel);
      // DHT data channel messages are handled by WebRTCRPC
    }
  }

  sendProfile(dataChannel) {
    if (dataChannel.readyState !== 'open') {
      console.error('Profile data channel is not open.');
      return;
    }

    try {
      console.log('Sending profile from offer side...');
      const profileData = JSON.stringify({ type: 'profile', profile: this.profile });
      sendData(dataChannel, profileData);
    } catch (error) {
      console.error('Error while sending profile:', error);
    }
  }

  sendPeerDTO(dataChannel, targetPeer) {
    if (dataChannel.readyState !== 'open') {
      console.error(`PeerDTO data channel not open for peer ${targetPeer.peerId}`);
      return;
    }
    try {
      const peerDto = {
        peerId: this.peerId,
        publicKey: this.profile.publicKey,
        age: calculateAge(this.profile.birthDay, this.profile.birthMonth, this.profile.birthYear),
        sex: this.profile.sex,
        searching: this.profile.searching,
        x: this.profile.x,
        y: this.profile.y,
        latitude: this.profile.latitude,
        longitude: this.profile.longitude
      };
      dataChannel.send(JSON.stringify(peerDto));
    } catch (error) {
      console.error(`Error sending PeerDTO to ${targetPeer.peerId}:`, error);
    }
  }

  async initiateConnection(targetPeer) {
    try {
      await verifyPublicKey(targetPeer.peerId, targetPeer.publicKey);
      const peerConnection = this.createPeerConnection(targetPeer);

      const signalingDataChannel = peerConnection.createDataChannel('signaling');
      this.setupDataChannel(signalingDataChannel, targetPeer);

      const profileDataChannel = peerConnection.createDataChannel('profile');
      this.setupDataChannel(profileDataChannel, targetPeer);

      const peerDtoDataChannel = peerConnection.createDataChannel('peer_dto');
      this.setupDataChannel(peerDtoDataChannel, targetPeer);

      const dhtDataChannel = peerConnection.createDataChannel('dht');
      this.setupDataChannel(dhtDataChannel, targetPeer);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const signalingMessage = await encryptAndSignOffer(
        this.peerId,
        targetPeer.peerId,
        offer,
        targetPeer.publicKey,
        this.profile.publicKey
      );

      // this.dht.addNode({id: this.peerId})

      this.socket.emit('messageOne', signalingMessage);
    } catch (error) {
      console.error(`Error initiating connection to ${targetPeer.peerId}:`, error);
    }
  }

  async handleSignalingMessage(message) {
    try {
      if ('encryptedOffer' in message) {
        await this.handleOffer(message, { peerId: message.from, publicKey: message.publicKey });
      } else if ('encryptedAnswer' in message) {
        await this.handleAnswer(message);
      } else if ('candidate' in message) {
        await this.handleIceCandidate(message);
      }
    } catch (error) {
      console.error(`Error handling signaling message from ${message.from}:`, error);
    }
  }

  async handleSignalingOverDataChannels(message, targetPeer, signalingDataChannel) {
    try {
      if (message.target === this.peerId) {
        await this.handleSignalingMessage(message);
      } else {
        const targetConnection = this.connections.get(message.target);
        if (targetConnection) {
          const targetDataChannel = this.dataChannels.get(`${message.target}:${this.peerId}:signaling`);
          if (targetDataChannel && targetDataChannel.readyState === 'open') {
            targetDataChannel.send(JSON.stringify(message));
          } else {
            console.warn(`Signaling data channel not open to peer ${message.target}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error handling signaling over data channels for ${targetPeer.peerId}:`, error);
    }
  }

  async handleOffer(message, senderPeer) {
    try {
      await verifyPublicKey(senderPeer.peerId, senderPeer.publicKey);
      const decryptedOffer = await verifyAndDecryptOffer(message, senderPeer.publicKey, this.peerId);
      const peerConnection = this.createPeerConnection(senderPeer);
      await peerConnection.setRemoteDescription(decryptedOffer);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      const signalingMessage = await encryptAnswer(
        this.peerId,
        senderPeer.peerId,
        answer,
        this.profile.publicKey
      );
      this.socket.emit('messageOne', signalingMessage);
    } catch (error) {
      console.error(`Error handling offer from ${senderPeer.peerId}:`, error);
    }
  }

  async handleAnswer(message) {
    try {
      const peerConnection = this.connections.get(message.from);
      if (!peerConnection) {
        console.warn(`No peer connection found for peer ${message.from}`);
        return;
      }
      if (peerConnection.signalingState !== 'have-local-offer') {
        console.warn(`Cannot set answer: signaling state is ${peerConnection.signalingState}`);
        return;
      }
      const decryptedAnswer = await decryptAnswer(message);
      await peerConnection.setRemoteDescription(decryptedAnswer);
    } catch (error) {
      console.error(`Error handling answer from ${message.from}:`, error);
    }
  }

  async handleIceCandidate(message) {
    try {
      const peerConnection = this.connections.get(message.from);
      if (peerConnection && peerConnection.remoteDescription) {
        await peerConnection.addIceCandidate(message.candidate);
      }
    } catch (error) {
      console.error(`Error handling ICE candidate from ${message.from}:`, error);
    }
  }

  closeConnection(peerId) {
    try {
      const peerConnection = this.connections.get(peerId);
      if (peerConnection) {
        peerConnection.close();
        this.connections.delete(peerId);
        for (const [key, dataChannel] of this.dataChannels) {
          if (key.startsWith(`${peerId}:`)) {
            dataChannel.close();
            this.dataChannels.delete(key);
          }
        }
      }
    } catch (error) {
      console.error(`Error closing connection with ${peerId}:`, error);
    }
  }

  disconnect() {
    try {
      if (this.dht) {
        this.dht.close();
      }
      if (this.socket) {
        this.socket.disconnect();
      }
      for (const peerConnection of this.connections.values()) {
        peerConnection.close();
      }
      this.connections.clear();
      this.dataChannels.clear();
    } catch (error) {
      console.error(`Error disconnecting peer ${this.peerId}:`, error);
    }
  }
}

module.exports = { WebRTCPeer };