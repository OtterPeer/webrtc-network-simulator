class CacheStrategy {
  cacheMessage(sender, recipient, message, nodeId, recipientFoundInBuckets) {}
  tryToDeliverCachedMessages(findAndPingNode, sendMessage, maxTTL) {
    return Promise.resolve();
  }
  getCachedMessageCount() { return 0; }
  clear() {}
  addCachedMessages(cachedMessages) {}
  getCachedMessages() { return new Map(); }
}

module.exports = { CacheStrategy };