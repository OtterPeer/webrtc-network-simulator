const EventEmitter = require('events');
const KBucket = require('./kbucket.js').default;

class CacheStrategy extends EventEmitter {
  cacheMessage(sender, recipient, message, nodeId, recipientFoundInBuckets) {}
  async tryToDeliverCachedMessages(findAndPingNode, sendMessage, maxTTL) {
    return Promise.resolve();
  }
  getCachedMessageCount() { return 0; }
  clear() {}
  addCachedMessages(cachedMessages) {}
  getCachedMessages() { return new Map(); }
}

class DistanceBasedCacheStrategy extends CacheStrategy {
  constructor(maxSize = 2000, distanceThreshold = Math.pow(2, 40)) {
    super();
    this.cachedMessages = new Map();
    this.accessOrder = [];
    this.maxSize = maxSize;
    this.distanceThreshold = distanceThreshold;
  }

  cacheMessage(sender, recipient, message, nodeId, recipientFoundInBuckets) {
    if (!message.id || this.cachedMessages.has(message.id)) {
    //   console.log(`Message ${message.id} already cached or no ID; skipping`);
      return;
    }

    const distanceHex = KBucket.xorDistance(nodeId, recipient);
    const distanceHexShort = distanceHex.substring(0, 12);
    const distance = parseInt(distanceHexShort, 16) || 0;

    // console.log(`Distance (48 most significant bits): ${distance}`);

    if (!recipientFoundInBuckets) {
      if (distance > this.distanceThreshold) {
        // console.log(`Distance too far (${distance} > ${this.distanceThreshold}); skipping`);
        return;
      }
    } else {
      console.log(`Recipient found in buckets, caching message ${message.id}`);
    }

    console.log("CACHING THE MESSAGE!")

    if (this.cachedMessages.size >= this.maxSize) {
      const oldestId = this.accessOrder.shift();
      if (oldestId) {
        this.cachedMessages.delete(oldestId);
        console.log(`Evicted oldest message ${oldestId} due to cache size limit`);
      }
    }

    const queued = {
      sender,
      recipient,
      message,
    };
    this.cachedMessages.set(message.id, queued);
    this.accessOrder.push(message.id);
    this.emit('messageCached');
    console.log(`Cached message ${message.id} for ${recipient} (DistanceBasedCacheStrategy)`);
  }

  async tryToDeliverCachedMessages(findAndPingNode, sendMessage, maxTTL) {
    console.log("Trying to deliver cached messages (LRU)");
    const now = Date.now();
    const toRemove = [];

    for (const [messageId, msg] of this.cachedMessages) {
      if (now - msg.message.timestamp > maxTTL) {
        console.log(`Message ${messageId} expired; removing`);
        toRemove.push(messageId);
        continue;
      }

      const targetNode = await findAndPingNode(msg.recipient);
      if (targetNode) {
        const success = await sendMessage(targetNode, msg.sender, msg.recipient, msg.message);
        if (success) {
          console.log(`Delivered cached message ${messageId} to ${msg.recipient}`);
          toRemove.push(messageId);
        } else {
          this.accessOrder = this.accessOrder.filter(id => id !== messageId);
          this.accessOrder.push(messageId);
        }
      } else {
        console.log(`Recipient ${msg.recipient} offline; keeping message ${messageId} in cache`);
        this.accessOrder = this.accessOrder.filter(id => id !== messageId);
        this.accessOrder.push(messageId);
      }
    }

    toRemove.forEach(id => {
      this.cachedMessages.delete(id);
      this.accessOrder = this.accessOrder.filter(aid => aid !== id);
    });

    this.emit('delivered');
  }

  addCachedMessages(cachedMessages) {
    for (const [key, value] of cachedMessages) {
      if (!this.cachedMessages.has(key)) {
        this.cachedMessages.set(key, value);
        this.accessOrder.push(key);
      }
    }
  }

  getCachedMessages() {
    return new Map(this.cachedMessages);
  }

  getCachedMessageCount() {
    return this.cachedMessages.size;
  }

  clear() {
    this.cachedMessages.clear();
    this.accessOrder = [];
  }
}

class DistanceBasedProbabilisticCacheStrategy extends CacheStrategy {
  constructor(maxSize = 100, distanceThreshold = Math.pow(2, 39), cacheProbability = 0.7) {
    super();
    this.cachedMessages = new Map();
    this.accessOrder = [];
    this.maxSize = maxSize;
    this.distanceThreshold = distanceThreshold;
    this.cacheProbability = cacheProbability;
  }

  cacheMessage(sender, recipient, message, nodeId, recipientFoundInBuckets) {
    if (!message.id || this.cachedMessages.has(message.id)) {
      console.log(`Message ${message.id} already cached or no ID; skipping`);
      return;
    }

    const distanceHex = KBucket.xorDistance(nodeId, recipient);
    const distanceHexShort = distanceHex.substring(0, 12);
    const distance = parseInt(distanceHexShort, 16) || 0;

    console.log(`Distance (48 most significant bits): ${distance}`);

    if (!recipientFoundInBuckets) {
      if (distance > this.distanceThreshold) {
        console.log(`Distance ${distance} exceeds threshold ${this.distanceThreshold}; not caching`);
        return;
      }

      if (Math.random() > this.cacheProbability) {
        console.log(`Probabilistic skip: Not caching message ${message.id} (probability=${this.cacheProbability})`);
        return;
      }
    } else {
      console.log(`Recipient found in buckets, caching message ${message.id}`);
    }

    if (this.cachedMessages.size >= this.maxSize) {
      const oldestId = this.accessOrder.shift();
      if (oldestId) {
        this.cachedMessages.delete(oldestId);
        console.log(`Evicted oldest message ${oldestId} due to cache size limit`);
      }
    }

    const queued = {
      sender,
      recipient,
      message,
    };
    this.cachedMessages.set(message.id, queued);
    this.accessOrder.push(message.id);
    this.emit('messageCached');
    console.log(`Cached message ${message.id} for ${recipient} with probability ${this.cacheProbability}`);
  }

  async tryToDeliverCachedMessages(findAndPingNode, sendMessage, maxTTL) {
    console.log("Trying to deliver cached messages (DistanceBasedProbabilistic)");
    const now = Date.now();
    const toRemove = [];

    for (const [messageId, msg] of this.cachedMessages) {
      if (now - msg.message.timestamp > maxTTL) {
        console.log(`Message ${messageId} expired; removing`);
        toRemove.push(messageId);
        continue;
      }

      const targetNode = await findAndPingNode(msg.recipient);
      if (targetNode) {
        const success = await sendMessage(targetNode, msg.sender, msg.recipient, msg.message);
        if (success) {
          console.log(`Delivered cached message ${messageId} to ${msg.recipient}`);
          toRemove.push(messageId);
        } else {
          this.accessOrder = this.accessOrder.filter(id => id !== messageId);
          this.accessOrder.push(messageId);
        }
      } else {
        console.log(`Recipient ${msg.recipient} offline; keeping message ${messageId} in cache`);
        this.accessOrder = this.accessOrder.filter(id => id !== messageId);
        this.accessOrder.push(messageId);
      }
    }

    toRemove.forEach(id => {
      this.cachedMessages.delete(id);
      this.accessOrder = this.accessOrder.filter(aid => aid !== id);
    });

    if (this.cachedMessages.size === 0) {
      this.emit('emptyCache')
    }

    this.emit('delivered');
  }

  addCachedMessages(cachedMessages) {
    throw new Error('Method not implemented in DistanceBasedProbabilisticCacheStrategy');
  }

  getCachedMessages() {
    throw new Error('Method not implemented in DistanceBasedProbabilisticCacheStrategy');
  }

  getCachedMessageCount() {
    return this.cachedMessages.size;
  }

  clear() {
    this.cachedMessages.clear();
    this.accessOrder = [];
  }
}

module.exports = { CacheStrategy, DistanceBasedCacheStrategy, DistanceBasedProbabilisticCacheStrategy };