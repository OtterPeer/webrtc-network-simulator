const EventEmitter = require('events');
const WebRTCRPC = require('./webrtc-rpc.js').default;
const KBucket = require('./kbucket.js').default;
const { ForwardToAllCloserForwardStrategy } = require('./forward-strategy.js');
const { DistanceBasedCacheStrategy, DistanceBasedProbabilisticCacheStrategy } = require('./cache-strategy.js');
const { v4: uuid } = require('uuid');
const fs = require('fs').promises;

class DHT extends EventEmitter {
  constructor(opts) {
    super();
    this.rpc = new WebRTCRPC({ nodeId: opts.nodeId });
    this.nodeId = opts.nodeId;
    this.buckets = new KBucket(this.nodeId, opts.k || 20);
    this.k = opts.k || 20;
    this.forwardedMessagesIds = new Set();
    this.receivedSignalingMessageIds = new Set();
    this.MAX_RECEIVED_IDS = 10000;
    this.forwardStrategy = new ForwardToAllCloserForwardStrategy();

    this.cacheStrategy = this.createCacheStrategy(
      opts.cacheStrategy || 'distance',
      opts.cacheSize || 1000,
      opts.cacheDistanceThreshold || Math.pow(2, 45), // tested in 50 peers network scenario
      opts.cacheProbability || 0.7
    );
    this.MAX_TTL = 48 * 3600 * 1000; // 48 hours in milliseconds
    this.ttlCleanupInterval = null;

    this.rpc.on("ping", (node) => this.addNode(node));
    this.rpc.on("message", this.handleMessage.bind(this));
    this.rpc.on("listening", (node) => {
      this.addNode(node);
      this.tryToDeliverCachedMessagesToTarget();
    });
    this.rpc.on("visualizationEvent", (event) => this.emit("visualizationEvent", event))
    this.cacheStrategy.on("messageCached", () => {
        this.emit("visualizationEvent",
          {
            type: 'cache',
            state: 'added',
            nodeId: this.nodeId,
            timestamp: Date.now()
          }
        )
      }
    )

    this.cacheStrategy.on("emptyCache", () => {
        this.emit("visualizationEvent",
          {
            type: 'cache',
            state: 'empty',
            nodeId: this.nodeId,
            timestamp: Date.now()
          }
        )
      }
    )

    this.loadState();
    this.startTTLCleanup();
    this.startReceivedIdsCleanup();

    if (opts.bootstrapNodeId) this.bootstrap({ id: opts.bootstrapNodeId });
  }

  sortClosestToSelf(peerIds) {
    return this.buckets.sortClosestToSelf(peerIds);
  }

  createCacheStrategy(name, cacheSize, distanceThreshold, cacheProbability) {
    switch (name.toLowerCase()) {
      case 'distance':
        return new DistanceBasedCacheStrategy(cacheSize, distanceThreshold);
      case 'distance_probabilistic':
        return new DistanceBasedProbabilisticCacheStrategy(cacheSize, distanceThreshold, cacheProbability);
      default:
        throw new Error(`Unknown cache strategy: ${name}`);
    }
  }

  async addNode(node) {
    const exists = this.buckets.all().some((n) => n.id === node.id);
    if (!exists) {
      console.log('Adding new node:', node.id);
      this.buckets.add(node);
      const alive = true; // don't send ping, other simulators are online
      // const alive = await this.rpc.ping(node);
      console.log('Received pong:', alive);
      if (alive) {
        this.emit('ready');
        this.tryToDeliverCachedMessagesToTarget();
      }
    } else {
      console.log('Node already exists:', node.id);
    }
  }

  setupDataChannel(targetPeerId, dataChannel) {
    this.rpc.setupDataChannel({ id: targetPeerId }, dataChannel);
  }

  async sendMessage(recipient, message) {
    const sender = message.senderId;
    const targetNodeInBuckets = this.buckets.all().find(node => node.id === recipient);
    if (targetNodeInBuckets) {
      const alive = await this.rpc.ping(targetNodeInBuckets);
      if (alive) {
        const success = await this.rpc.sendMessage(targetNodeInBuckets, sender, recipient, message);
        if (success) {
          console.log(`Message ${message.id} delivered to ${recipient}`);
        } else {
          this.cacheMessage(this.nodeId, recipient, message, true);
          this.forward(sender, recipient, message, true);
        }
      } else {
        this.cacheMessage(this.nodeId, recipient, message, true);
        this.forward(sender, recipient, message, true);
      }
    } else {
      console.log(`Routing message ${message.id} through other peers`);
      this.cacheMessage(this.nodeId, recipient, message, false);
      this.forward(sender, recipient, message, false);
    }
  }

  async sendSignalingMessage(recipient, signalingMessage, sender = null) {
    let originNode = false;
    if (!sender) {
      sender = this.nodeId;
      originNode = true;
      console.log(`Sending signaling message over DHT from peer ${this.nodeId} to ${recipient}`)
    }

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
        this.forward(sender, recipient, signalingMessage, originNode, true);
      }
    } else {
      console.log(`Routing signaling message ${signalingMessage.id} through other peers`);
      this.forward(sender, recipient, signalingMessage, originNode, false);
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
      if (!sender || !recipient || !message || !message.id || !message.senderId) {
        console.warn("Invalid message; dropping.");
        return;
      }

      this.addNode(from);
      if (recipient === this.nodeId) {
        console.log(`Received message ${message.id} for self: ${message.encryptedMessage}`);
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

      console.log(signalingMessage.id);

      if (this.receivedSignalingMessageIds.has(signalingMessage.id)) {
        console.log(`Duplicate signaling message ${signalingMessage.id} received; skipping.`);
        return;
      }

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
    }, 5 * 60 * 1000);
  }

  cacheMessage(sender, recipient, message, recipientFoundInBuckets) {
    this.cacheStrategy.cacheMessage(sender, recipient, message, this.nodeId, recipientFoundInBuckets);
    this.emit("cache", { sender, recipient, message });
  }

  async tryToDeliverCachedMessagesToTarget() {
    await this.cacheStrategy.tryToDeliverCachedMessages(
      (targetId) => this.findAndPingNode(targetId),
      (node, sender, recipient, message) => {
        return this.rpc.sendMessage(node, sender, recipient, message);
      },
      this.MAX_TTL
    );
    this.emit("delivered");
  }

  async saveState() {
    try {
      const messagesArray = Array.from(this.cacheStrategy.getCachedMessages());
      await fs.writeFile(`dht_${this.nodeId}_cachedMessages.json`, JSON.stringify(messagesArray));

      const nodes = this.buckets.all().map(node => ({ id: node.id }));
      await fs.writeFile(`dht_${this.nodeId}_kBucket.json`, JSON.stringify(nodes));
    } catch (error) {
      console.error(`Error saving state for node ${this.nodeId}:`, error);
      throw error;
    }
  }

  async loadState() {
    try {
      const cachedMessages = await fs.readFile(`dht_${this.nodeId}_cachedMessages.json`, 'utf8').catch(() => null);
      if (cachedMessages) {
        const messagesArray = JSON.parse(cachedMessages);
        this.cacheStrategy.addCachedMessages(new Map(messagesArray));
      }

      const nodesJson = await fs.readFile(`dht_${this.nodeId}_kBucket.json`, 'utf8').catch(() => null);
      if (nodesJson) {
        const nodes = JSON.parse(nodesJson);
        for (const node of nodes) {
          this.buckets.add({ id: node.id });
        }
      }
      console.log("Loaded DHT state:");
      console.log(this.cacheStrategy.getCachedMessages());
      console.log(this.buckets);
    } catch (error) {
      console.error(`Error loading state for node ${this.nodeId}:`, error);
      throw error;
    }
  }

  startTTLCleanup() {
    this.ttlCleanupInterval = setInterval(() => {
      this.cacheStrategy.tryToDeliverCachedMessages(
        (targetId) => this.findAndPingNode(targetId),
        (node, sender, recipient, message) => {
          return this.rpc.sendMessage(node, sender, recipient, message);
        },
        this.MAX_TTL
      ).then(() => {
        console.log(`Cleaned up expired messages; ${this.cacheStrategy.getCachedMessageCount()} remain`);
      });
    }, 5 * 60 * 1000);
  }

  stopTTLCleanup() {
    if (this.ttlCleanupInterval) {
      clearInterval(this.ttlCleanupInterval);
      this.ttlCleanupInterval = null;
    }
  }

  async findAndPingNode(targetId) {
    const closest = this.buckets.closest(targetId, this.k);
    for (const node of closest) {
      if (node.id === targetId) {
        const alive = await this.rpc.ping(node);
        if (alive) return node;
      }
    }
    console.log("Node not found in buckets or didn't respond to ping");
    return null;
  }

  async bootstrap(bootstrapNode) {
    console.log("Adding bootstrap node...");
    await this.addNode(bootstrapNode);
    const alive = await this.rpc.ping(bootstrapNode);
    if (alive) this.emit("ready");
  }

  close() {
    this.stopTTLCleanup();
    this.rpc.close();
    this.receivedSignalingMessageIds.clear();
    this.cacheStrategy.clear();
  }
}

module.exports = { default: DHT };