const EventEmitter = require('events');
const WebRTCRPC = require('./webrtc-rpc.js').default;
const KBucket = require('./kbucket.js').default;
const { ForwardToAllCloserForwardStrategy } = require('./forward-strategy.js');
const { v4: uuid } = require('uuid');

class DHT extends EventEmitter {
  constructor(opts) {
    super();
    this.rpc = new WebRTCRPC({ nodeId: opts.nodeId });
    this.nodeId = opts.nodeId;
    this.buckets = new KBucket(this.nodeId, opts.k || 20);
    this.k = opts.k || 20;
    this.forwardedMessagesIds = new Set();
    this.receivedSignalingMessageIds = new Set();
    this.MAX_RECEIVED_IDS = 10000; // Maximum number of signaling message IDs to store
    this.forwardStrategy = new ForwardToAllCloserForwardStrategy();
    this.forwardedMessages = new Map();

    this.rpc.on("ping", (node) => this.addNode(node));
    this.rpc.on("message", this.handleMessage.bind(this));
    this.rpc.on("listening", (node) => this.addNode(node));

    this.startReceivedIdsCleanup();
  }

  async addNode(node) {
    const exists = this.buckets.all().some((n) => n.id === node.id);
    if (!exists) {
      console.log('Adding new node:', node.id);
      this.buckets.add(node);
      const alive = await this.rpc.ping(node); // Await the ping result (true if pong received)
      console.log('Received pong:', alive);
      if (alive) {
        this.emit('ready');
      }
    } else {
      console.log('Node already exists:', node.id);
    }
  }

  setupDataChannel(targetPeerId, dataChannel) {
    this.rpc.setupDataChannel({ id: targetPeerId }, dataChannel);
  }

  async sendMessage(recipient, message) {
    const targetNodeInBuckets = this.buckets.all().find(node => node.id === recipient);
    if (targetNodeInBuckets) {
      const alive = await this.rpc.ping(targetNodeInBuckets); // Await ping to ensure node is alive
      if (alive) {
        const success = await this.rpc.sendMessage(targetNodeInBuckets, this.nodeId, recipient, message);
        if (success) {
          console.log(`Message ${message.id} delivered to ${recipient}`);
        } else {
          this.forward(this.nodeId, recipient, message, true);
        }
      } else {
        console.log(`Node ${recipient} did not respond to ping; forwarding message`);
        this.forward(this.nodeId, recipient, message, true);
      }
    } else {
      console.log(`Routing message ${message.id} through other peers`);
      this.forward(this.nodeId, recipient, message, true);
    }
  }

  async sendSignalingMessage(recipient, signalingMessage, sender = null) {
    let originNode = false;
    if (!sender) {
      sender = this.nodeId;
      originNode = true;
    }

    // Assign an ID for deduplication if none exists
    if (!signalingMessage.id) {
      signalingMessage.id = uuid();
    }

    const targetNodeInBuckets = this.buckets.all().find(node => node.id === recipient);
    if (targetNodeInBuckets) {
      const alive = await this.rpc.ping(targetNodeInBuckets);
      if (alive) {
        const success = await this.rpc.sendMessage(targetNodeInBuckets, sender, recipient, null, signalingMessage);
        if (success) {
          console.log(`Signaling message ${signalingMessage.id} delivered to ${recipient}`);
          this.forwardedMessagesIds.add(signalingMessage.id);
        } else {
          this.forward(sender, recipient, signalingMessage, originNode, true);
        }
      } else {
        console.log(`Node ${recipient} did not respond to ping; forwarding signaling message`);
        this.forward(sender, recipient, signalingMessage, originNode, true);
      }
    } else {
      console.log(`Routing signaling message ${signalingMessage.id} through other peers`);
      this.forward(sender, recipient, signalingMessage, originNode, true);
    }
  }

  forward(sender, recipient, message, originNode, forceForwardingToKPeers = false) {
    this.forwardStrategy.forward(
      sender,
      recipient,
      message,
      this.buckets,
      { sendMessage: this.rpc.sendMessage.bind(this.rpc) },
      this.k,
      this.nodeId,
      this.forwardedMessagesIds,
      originNode,
      forceForwardingToKPeers,
      this.emit.bind(this)
    ).then(() => {
      console.log(`Forwarding completed for message ${message.id}`);
    }).catch(error => {
      console.error(`Forwarding failed: ${error}`);
    });
  }

  handleMessage(rpcMessage, from) {
    console.log(`Handling message: ${rpcMessage.type}. From: ${from.id}`);

    if (rpcMessage.type === 'message') {
      const { sender, recipient, message } = rpcMessage;
      if (!sender || !recipient || !message || !message.id) {
        console.warn("Invalid message; dropping.");
        return;
      }

      this.addNode(from);
      if (recipient === this.nodeId) {
        console.log(`Received message ${message.id} for self: ${message.content}`);
        this.emit("chatMessage", message);
      } else {
        this.sendMessage(recipient, message);
      }
    } else if (rpcMessage.type === 'signaling') {
      const { sender, recipient, signalingMessage } = rpcMessage;
      if (!sender || !recipient || !signalingMessage || !signalingMessage.id) {
        console.warn("Invalid signaling message; dropping.");
        return;
      }

      // Check for duplicate signaling message
      if (this.receivedSignalingMessageIds.has(signalingMessage.id)) {
        console.log(`Duplicate signaling message ${signalingMessage.id} received; skipping.`);
        return;
      }

      // Add to received IDs and clean up if necessary
      this.receivedSignalingMessageIds.add(signalingMessage.id);
      if (this.receivedSignalingMessageIds.size > this.MAX_RECEIVED_IDS) {
        this.cleanupReceivedSignalingMessageIds();
      }

      this.addNode(from);
      if (recipient === this.nodeId) {
        console.log(`Received signaling message ${signalingMessage.id} for self:`, signalingMessage);
        this.emit("signalingMessage", signalingMessage);
      } else {
        this.sendSignalingMessage(recipient, signalingMessage, sender);
      }
    } else {
      console.warn(`Received unexpected message type ${rpcMessage.type}; dropping.`);
    }
  }

  cleanupReceivedSignalingMessageIds() {
    const ids = Array.from(this.receivedSignalingMessageIds);
    if (ids.length > this.MAX_RECEIVED_IDS) {
      const toRemove = ids.slice(0, ids.length - this.MAX_RECEIVED_IDS);
      toRemove.forEach(id => this.receivedSignalingMessageIds.delete(id));
      console.log(`Cleaned up ${toRemove.length} old signaling message IDs`);
    }
  }

  startReceivedIdsCleanup() {
    setInterval(() => {
      this.cleanupReceivedSignalingMessageIds();
    }, 5 * 60 * 1000); // Clean up every 5 minutes
  }

  close() {
    this.rpc.close();
    this.receivedSignalingMessageIds.clear();
  }
}

module.exports = { default: DHT };