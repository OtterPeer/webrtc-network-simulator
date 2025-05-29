const WebRTCPeer = require('./webrtc-peer.js').WebRTCPeer;

process.on('message', async (msg) => {
  if (msg.type === 'init') {
    const { profile, signalingServerURL, token, iceServers, peerIndex } = msg;
    try {
      const peer = new WebRTCPeer(profile, signalingServerURL, token, iceServers);
      await peer.init();
    //   console.log(`Peer ${peerIndex + 1} initialized with ID: ${peer.peerId}`);

      // Send peer info back to parent
      process.send({
        type: 'peerInfo',
        peerId: peer.peerId,
        publicKey: peer.profile.publicKey,
        peerIndex
      });

      peer.on('visualizationEvent', (event) => {
        process.send({
          type: 'visualizationEvent',
          event
        });
      });

      peer.dht.on('chatMessage', (message) => {
        // console.log(`Peer ${peerIndex + 1} received message:`, message);
      });

      process.peer = peer;

      process.send({ type: 'ready', peerIndex });
    } catch (error) {
      console.error(`Error initializing peer ${peerIndex + 1}:`, error);
      process.send({ type: 'error', peerIndex, error: error.message });
    }
  } else if (msg.type === 'sendMessage') {
    const { recipientId, message } = msg;
    if (process.peer) {
      try {
        await process.peer.dht.sendMessage(recipientId, message);
        // console.log(`Peer ${process.peer.peerId} sent message to ${recipientId}`);
      } catch (error) {
        console.error(`Error sending message from ${process.peer.peerId} to ${recipientId}:`, error);
      }
    }
  } else if (msg.type === 'shutdown') {
    if (process.peer) {
      process.peer.disconnect();
    //   console.log(`Peer ${process.peer.peerId} disconnected`);
    }
    process.exit(0);
  }
});

process.on('SIGINT', () => {
  if (process.peer) {
    process.peer.disconnect();
  }
  process.exit(0);
});