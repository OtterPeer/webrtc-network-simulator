const KBucket = require('./kbucket.js').default;

class ForwardToAllCloserForwardStrategy {
  async forward(
    sender,
    recipient,
    message,
    buckets,
    rpc,
    k,
    nodeId,
    forwardedMessagesIds,
    originNode,
    forceForwardingToKPeers,
    emit
  ) {
    const messageId = message.id;
    if (messageId && forwardedMessagesIds.has(messageId)) {
      console.log(`Message ${messageId} already forwarded; skipping`);
      return;
    }
    emit("nodeProcessesMessage");
    const selfDistanceToTarget = KBucket.xorDistance(nodeId, recipient);
    const closest = buckets.closest(recipient, k);

    let peersToForward;
    if (forceForwardingToKPeers) {
      peersToForward = closest.filter(node => node.id !== sender && node.id !== nodeId);
    } else {
      peersToForward = closest.filter(node => {
        if (node.id === sender || node.id === nodeId) return false;
        const peerDistanceToTarget = KBucket.xorDistance(node.id, recipient);
        return peerDistanceToTarget < selfDistanceToTarget;
      });
    }

    console.log(`Forwarding message to ${peersToForward.length} peers: ${peersToForward.map(n => n.id).join(', ')}`);

    let forwarded = false;
    try {
      for (const node of peersToForward) {
        emit("sent", { sender, recipient, content: message });
        const isSignaling = !message.content; // If there's no 'content', it's a signaling message
        await rpc.sendMessage(
          node,
          sender,
          recipient,
          isSignaling ? null : message,
          isSignaling ? message : null
        );
        emit("forward", { sender: nodeId, recipient: node.id, message });
        forwarded = true;
      }

      if (messageId) {
        forwardedMessagesIds.add(messageId);
      }

      if (!forwarded) {
        console.log(`No peers available to forward message; skipping cache since caching is not implemented`);
      } else {
        console.log(`Message forwarded`);
      }
    } catch (error) {
      console.error(`Error forwarding message: ${error}`);
      throw error;
    }
  }
}

module.exports = { ForwardToAllCloserForwardStrategy };