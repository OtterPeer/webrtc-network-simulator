class KBucket {
  constructor(localId, k = 20) {
    this.buckets = Array(160).fill(null).map(() => []);
    this.localId = localId;
    this.k = k;
  }

  static xorDistance(id1, id2) {
    const b1 = Buffer.from(id1, "hex");
    const b2 = Buffer.from(id2, "hex");
    const result = Buffer.alloc(b1.length);
    for (let i = 0; i < b1.length; i++) result[i] = b1[i] ^ b2[i];
    return result.toString("hex");
  }

  sortClosestToSelf(peerIds) {
    const distances = peerIds.map((peerId) => ({
      peerId,
      distance: KBucket.xorDistance(this.localId, peerId),
    }));
    distances.sort((a, b) => a.distance.localeCompare(b.distance)); // Hex string comparison
    return distances.map((d) => d.peerId);
  }

  add(node) {
    if (node.id === this.localId) return;
    const distance = KBucket.xorDistance(this.localId, node.id);
    const bucketIndex = this.bucketIndex(distance);
    const bucket = this.buckets[bucketIndex];
    if (!bucket.some(n => n.id === node.id)) {
      if (bucket.length < this.k) bucket.push(node);
      else {
        bucket.shift();
        bucket.push(node);
      }
    }
  }

  bucketIndex(distance) {
    const d = Buffer.from(distance, "hex");
    for (let i = 0; i < d.length; i++)
      for (let j = 7; j >= 0; j--)
        if ((d[i] & (1 << j)) !== 0) return i * 8 + (7 - j);
    return 0;
  }

  closest(target, k = this.k) {
    const distances = this.all().map(node => ({
      node,
      distance: KBucket.xorDistance(node.id, target)
    }));
    distances.sort((a, b) => a.distance.localeCompare(b.distance));
    return distances.slice(0, k).map(d => d.node);
  }

  all() {
    return this.buckets.flat();
  }
}

module.exports = { default: KBucket };