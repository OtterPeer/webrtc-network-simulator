const wrtc = require('@roamhq/wrtc');
const { Socket, io } = require('socket.io-client');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');
const DHT = require('./dht.js').default;
const EventEmitter = require('events');
const ConnectionManager = require('./connection-manager.js').ConnectionManager;

// In-memory store for user data (replacing userdb)
const userStore = new Map();

// In-memory store for private keys (replacing AsyncStorage)
const privateKeyStore = new Map();

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

function createSHA1Hash(inputString) {
  return crypto.createHash('sha1').update(inputString).digest('hex');
}

function derivePeerId(publicKey) {
  return createSHA1Hash(publicKey);
}

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

async function encryptAndSignOffer(senderId, targetId, sessionDescription, targetPublicKey, senderPublicKey) {
  try {
    let aesKey, iv, keyId;
    const targetUser = userStore.get(targetId);
    if (!targetUser || !targetUser.aesKey || !targetUser.iv || !targetUser.keyId) {
      aesKey = crypto.randomBytes(32).toString('base64');
      iv = crypto.randomBytes(12).toString('base64');
      keyId = uuid();
      userStore.set(targetId, {
        ...userStore.get(targetId),
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
        ...userStore.get(from),
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
      publicKey: senderPublicKey,
      keyId: user.keyId
    };
  } catch (error) {
    console.error(`Error encrypting answer for target ${targetId}:`, error);
    throw error;
  }
}

async function decryptAnswer(encryptedRTCSessionDescription) {
  try {
    const senderUser = userStore.get(encryptedRTCSessionDescription.from);
    if (!senderUser || !senderUser.aesKey || !senderUser.iv) {
      throw new Error(`No AES key or IV found for peer ${encryptedRTCSessionDescription.from}`);
    }
    const aesKey = senderUser.aesKey;
    const iv = senderUser.iv;

    const decryptedAnswer = decryptAndDecodeMessage(aesKey, iv, encryptedRTCSessionDescription.authTag, encryptedRTCSessionDescription.encryptedAnswer);
    return { sdp: decryptedAnswer, type: 'answer' };
  } catch (error) {
    throw error;
  }
}

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

  try {
    sendChunk();
  } catch(err) {
    console.error(err);
  }
}

class WebRTCPeer extends EventEmitter {
  constructor(profile, signalingServerURL, token, iceServers) {
    super();
    this.profile = profile;
    this.peerId = derivePeerId(profile.publicKey);
    this.profile.peerId = this.peerId;
    this.signalingServerURL = signalingServerURL;
    this.token = token;
    this.iceServers = iceServers;
    this.connections = new Map();
    this.dataChannels = new Map();
    this.socket = null;
    this.dht = null;
    this.connectionManager = null;
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
      ...userStore.get(this.peerId),
      peerId: this.peerId,
      publicKey: this.profile.publicKey,
      x: this.profile.x,
      y: this.profile.y,
      sex: this.profile.sex,
      searching: this.profile.searching,
      age: calculateAge(this.profile.birthDay, this.profile.birthMonth, this.profile.birthYear),
      latitude: this.profile.latitude,
      longitude: this.profile.longitude
    });

    this.dht = new DHT({ nodeId: this.peerId });
    this.dht.on('ready', () => {
      console.log(`DHT for peer ${this.peerId} is ready`);
    });

    this.dht.on("visualizationEvent", (event) => {
      this.emit("visualizationEvent", event);
    });

    this.dht.on("signalingMessage", (event) => this.handleSignalingMessage(event, null, true));

    this.connectionManager = new ConnectionManager(
      this.connections,
      this.dataChannels,
      this.dht,
      (targetPeer, signalingDataChannel, useDHTForSignaling) => this.initiateConnection(targetPeer, signalingDataChannel, useDHTForSignaling),
      userStore
    );
    this.connectionManager.start();

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
          if (message.payload && message.payload.connections) {
            this.connectionManager.handleNewPeers(message.payload.connections, null);
          } else {
            this.handleSignalingMessage(message);
          }
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

  createPeerConnection(targetPeer, signalingDataChannel = null) {
    try {
      const peerConnection = new wrtc.RTCPeerConnection({ iceServers: this.iceServers });

      // todo: queue ice candidatates till the answer is received on the offer side
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          const iceCandidateMessage = {
            target: targetPeer.peerId,
            from: this.peerId,
            candidate: event.candidate
          };
          if (signalingDataChannel) {
            signalingDataChannel.send(JSON.stringify(iceCandidateMessage));
          } else if (targetPeer.useDHTForSignaling === true) {
            this.dht.sendSignalingMessage(targetPeer.peerId, iceCandidateMessage);
          } else {
            this.socket.emit('messageOne', iceCandidateMessage);
          }
        }
      };

      peerConnection.oniceconnectionstatechange = () => {
        console.log(`I'm peer ${this.peerId}. Connection state with peer: ${targetPeer.peerId} ICE state: ${peerConnection.iceConnectionState}`);
        if (peerConnection.iceConnectionState === 'connected') {
          this.emit('visualizationEvent', {
            type: 'connection',
            from: this.peerId,
            to: targetPeer.peerId,
            state: 'connected',
            timestamp: Date.now()
          });
        }
        if (peerConnection.iceConnectionState === 'disconnected' || peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'closed') {
          console.log("here")
          this.emit('visualizationEvent', {
            type: 'connection',
            from: this.peerId,
            to: targetPeer.peerId,
            state: 'disconnected',
            timestamp: Date.now()
          });
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
          this.emit('visualizationEvent', {
            type: 'message',
            from: targetPeer.peerId,
            to: this.peerId,
            message: 'Profile Request',
            timestamp: Date.now()
          });
        } else {
          this.emit('visualizationEvent', {
            type: 'message',
            from: targetPeer.peerId,
            to: this.peerId,
            message: 'Profile Data',
            timestamp: Date.now()
          });
        }
      };
    } else if (label === 'peer_dto') {
      dataChannel.onmessage = (event) => {
        if (event.data === 'request_peer_dto') {
          console.log(`Received peer_dto request from ${targetPeer.peerId}`);
          this.sendPeerDTO(dataChannel, targetPeer);
          this.emit('visualizationEvent', {
            type: 'message',
            from: targetPeer.peerId,
            to: this.peerId,
            message: 'PeerDTO Request',
            timestamp: Date.now()
          });
        } else {
          const data = event.data;
          console.log("Received peerDTO response:", data);
          const peerDto = JSON.parse(data);

          userStore.set(peerDto.peerId, {
            ...userStore.get(peerDto.peerId),
            peerId: peerDto.peerId,
            publicKey: peerDto.publicKey,
            age: peerDto.age || 0,
            sex: peerDto.sex || [0, 0, 0],
            searching: peerDto.searching || [0, 0, 0],
            x: peerDto.x || 0,
            y: peerDto.y || 0,
            latitude: peerDto.latitude || 0,
            longitude: peerDto.longitude || 0
          });

          // this.emit('visualizationEvent', {
          //   type: 'message',
          //   from: targetPeer.peerId,
          //   to: this.peerId,
          //   message: 'PeerDTO Data',
          //   timestamp: Date.now()
          // });
        }
      };
    } else if (label === 'signaling') {
      dataChannel.onmessage = (event) => {
        this.emit('visualizationEvent', {
          type: 'message',
          from: targetPeer.peerId,
          to: this.peerId,
          message: 'Signaling over Datachannels',
          timestamp: Date.now()
        });
        try {
          const message = JSON.parse(event.data);
          this.handleSignalingOverDataChannels(message, targetPeer, dataChannel);
        } catch (error) {
          console.error(`Error parsing signaling message from ${targetPeer.peerId}:`, error);
        }
      };
    } else if (label === 'dht') {
      this.dht.setupDataChannel(targetPeer.peerId, dataChannel);
    } else if (label === 'pex') {
      dataChannel.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "request") {
            this.connectionManager.shareConnectedPeers(dataChannel, message, userStore);
            this.emit('visualizationEvent', {
              type: 'message',
              from: targetPeer.peerId,
              to: this.peerId,
              message: 'PEX Request',
              timestamp: Date.now()
            });
          } else if (message.type === "advertisement") {
            const receivedPeers = message.peers;
            this.connectionManager.handleNewPeers(receivedPeers, dataChannel);
            this.emit('visualizationEvent', {
              type: 'message',
              from: targetPeer.peerId,
              to: this.peerId,
              message: 'PEX Advertisement',
              timestamp: Date.now()
            });
          }
        } catch (error) {
          console.error("Error handling PEX request:", error);
        }
      };
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
      this.emit('visualizationEvent', {
        type: 'message',
        from: this.peerId,
        to: targetPeer.peerId,
        message: 'PeerDTO Data',
        timestamp: Date.now()
      });
    } catch (error) {
      console.error(`Error sending PeerDTO to ${targetPeer.peerId}:`, error);
    }
  }

  async initiateConnection(targetPeer, signalingDataChannel = null, useDHTForSignaling = false) {
    if (targetPeer.peerId === this.peerId) {
      return;
    }
    try {
      targetPeer.useDHTForSignaling = useDHTForSignaling;
      await verifyPublicKey(targetPeer.peerId, targetPeer.publicKey);
      const peerConnection = this.createPeerConnection(targetPeer, signalingDataChannel);

      const signalingDataChannelWithTargetPeer = peerConnection.createDataChannel('signaling');
      this.setupDataChannel(signalingDataChannelWithTargetPeer, targetPeer);

      const profileDataChannel = peerConnection.createDataChannel('profile');
      this.setupDataChannel(profileDataChannel, targetPeer);

      const peerDtoDataChannel = peerConnection.createDataChannel('peer_dto');
      this.setupDataChannel(peerDtoDataChannel, targetPeer);

      const dhtDataChannel = peerConnection.createDataChannel('dht');
      this.setupDataChannel(dhtDataChannel, targetPeer);

      const pexDataChannel = peerConnection.createDataChannel('pex');
      this.setupDataChannel(pexDataChannel, targetPeer);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const signalingMessage = await encryptAndSignOffer(
        this.peerId,
        targetPeer.peerId,
        offer,
        targetPeer.publicKey,
        this.profile.publicKey
      );

      if (useDHTForSignaling === true) {
        this.dht.sendSignalingMessage(targetPeer.peerId, signalingMessage);
      } else if (signalingDataChannel) {
        signalingDataChannel.send(JSON.stringify(signalingMessage));
      } else {
        this.socket.emit('messageOne', signalingMessage);
      }
    } catch (error) {
      console.error(`Error initiating connection to ${targetPeer.peerId}:`, error);
    }
  }

  async handleSignalingMessage(message, signalingDataChannel = null, useDHTForSignaling = false) {
    try {
      if ('encryptedOffer' in message) {
        await this.handleOffer(message, { peerId: message.from, publicKey: message.publicKey, useDHTForSignaling }, signalingDataChannel);
      } else if ('encryptedAnswer' in message) {
        await this.handleAnswer(message);//todo: add possibility to initiate signaling over datachannels
      } else if ('candidate' in message) {
        await this.handleIceCandidate(message);
      }
    } catch (error) {
      // console.error(`Error handling signaling message from ${message.from}:`, error);
    }
  }

  async handleSignalingOverDataChannels(message, targetPeer, signalingDataChannel) {
    try {
      if (message.target === this.peerId) {
        await this.handleSignalingMessage(message, signalingDataChannel);
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

  async handleOffer(message, senderPeer, signalingDataChannel) {
    try {
      await verifyPublicKey(senderPeer.peerId, senderPeer.publicKey);
      const decryptedOffer = await verifyAndDecryptOffer(message, senderPeer.publicKey, this.peerId);
      const peerConnection = this.createPeerConnection(senderPeer, signalingDataChannel);
      await peerConnection.setRemoteDescription(decryptedOffer);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      const signalingMessage = await encryptAnswer(
        this.peerId,
        senderPeer.peerId,
        answer,
        this.profile.publicKey
      );
      if (signalingDataChannel) {
        signalingDataChannel.send(JSON.stringify(signalingMessage))
      } else if (senderPeer.useDHTForSignaling === true) {
        this.dht.sendSignalingMessage(senderPeer.peerId, signalingMessage)
      }
       else {
        this.socket.emit('messageOne', signalingMessage);
      }
      setTimeout(() => {
        const peerDtoDataChannel = this.dataChannels.get(`${senderPeer.peerId}:${this.peerId}:peer_dto`);
        if (peerDtoDataChannel && peerDtoDataChannel.readyState === "open") {
          peerDtoDataChannel.send('request_peer_dto');
          console.log("PeerDTO request sent")
        } else {
          console.error(peerDtoDataChannel)
        }
      }, 2000);
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
      // console.error(`Error handling answer from ${message.from}:`, error);
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
      if (this.connectionManager) {
        this.connectionManager.stop();
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

module.exports = { WebRTCPeer, userStore };