const EventEmitter = require('events');
const WebRTCPeer = require('./webrtc-peer.js').WebRTCPeer;
const { v4: uuid } = require('uuid');

class WebRTCRPC extends EventEmitter {
  constructor({ nodeId }) {
    super();
    this.id = nodeId;
    this.dataChannels = new Map(); // Map of nodeId to dht data channel
  }

  // Initialize data channel for DHT communication
  setupDataChannel(node, dataChannel) {
    dataChannel.onmessage = (event) => {
      this.handleMessage(event, node);
    };

    dataChannel.onopen = () => {
      this.emit("listening", node);
      console.log(`DHT data channel opened with ${node.id}`);
    };

    dataChannel.onclose = () => {
      console.log(`DHT data channel closed with ${node.id}`);
      this.dataChannels.delete(node.id);
    };

    dataChannel.onerror = (error) => {
      console.error(`DHT data channel error with ${node.id}:`, error);
    };

    this.dataChannels.set(node.id, dataChannel);
    return dataChannel;
  }

  // Handle incoming messages
  handleMessage(event, node) {
    try {
      const rpcMessage = JSON.parse(event.data);
      console.log(`Received rpc message: ${JSON.stringify(rpcMessage)}`);

      if (rpcMessage.type === 'ping') {
        console.log(`Received ping from ${node.id} with id ${rpcMessage.id}`);
        const pongMessage = { type: 'pong', sender: this.id, id: rpcMessage.id };
        const dataChannel = this.dataChannels.get(node.id);
        if (dataChannel && dataChannel.readyState === 'open') {
          dataChannel.send(JSON.stringify(pongMessage));
        }
        this.emit('ping', node);
      } else if (rpcMessage.type === 'pong') {
        this.emit('message', rpcMessage, node);
      } else if (rpcMessage.type === 'message' || rpcMessage.type === 'signaling') {
        this.emit('message', rpcMessage, node);
      }
    } catch (error) {
      console.error(`Error parsing DHT message from ${node.id}:`, error);
    }
  }

  async ping(node) {
    try {
      const dataChannel = this.dataChannels.get(node.id);
      if (!dataChannel || dataChannel.readyState !== 'open') {
        console.log(`DHT data channel not open for ${node.id}, message was not sent`);
        return false;
      }

      console.log(`Sending DHT ping to node ${node.id}`);
      return new Promise((resolve) => {
        const pingId = uuid();
        dataChannel.send(JSON.stringify({ type: 'ping', sender: this.id, id: pingId }));

        const onPong = (message, from) => {
          if (message.type === 'pong' && message.id === pingId && from.id === node.id) {
            this.removeListener('message', onPong);
            resolve(true);
          }
        };
        this.on('message', onPong);

        setTimeout(() => {
          this.removeListener('message', onPong);
          resolve(false);
        }, 10_000); // 10-second timeout
      });
    } catch (error) {
      console.error(`Error pinging node ${node.id}:`, error);
      return false;
    }
  }

  async sendMessage(node, sender, recipient, message = null, signalingMessage = null) {
    try {
      const dataChannel = this.dataChannels.get(node.id);
      if (!dataChannel || dataChannel.readyState !== 'open') {
        console.log(`DHT data channel not open for ${node.id}, message was not sent`);
        return false;
      }

      const rpcMessage = {
        type: signalingMessage ? 'signaling' : 'message',
        sender,
        recipient,
        message,
        signalingMessage
      };
      dataChannel.send(JSON.stringify(rpcMessage));
      return true;
    } catch (error) {
      console.error(`Error sending message to ${node.id}:`, error);
      return false;
    }
  }

  getId() {
    return this.id;
  }

  close() {
    for (const dataChannel of this.dataChannels.values()) {
      dataChannel.close();
    }
    this.dataChannels.clear();
  }
}

module.exports = { default: WebRTCRPC };