class ConnectionManager {
  constructor(
    connections,
    pexDataChannels,
    dht,
    initiateConnection
  ) {
    this.minConnections = 3;
    this.checkInterval = 10 * 1000; // 10s for buffer checks
    this.connections = connections; // Map of peerId to RTCPeerConnection
    this.pexDataChannels = pexDataChannels; // Map of peerId to RTCDataChannel
    this.dht = dht;
    this.initiateConnection = initiateConnection;
    this.intervalId = null;
    this.hasTriggeredInitialConnections = false;
  }

  start() {
    if (this.intervalId) {
      console.warn("ConnectionManager is already running");
      return;
    }
    this.performInitialConnections();
    this.intervalId = setInterval(() => {
      this.checkConnectionsAndConnect();
    }, this.checkInterval);
    console.log("ConnectionManager started");
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("ConnectionManager stopped");
    }
  }

  async performInitialConnections() {
    if (this.hasTriggeredInitialConnections) {
      console.log("Initial PEX/DHT connections already triggered");
      return;
    }
    await delay(2000);
    console.log("Performing initial PEX request to closest peer known.");
    this.performPEXRequestToClosestPeer(this.minConnections);
    // await this.tryToRestoreDHTConnections(5); // Try to connect to 5 peers from DHT
    this.hasTriggeredInitialConnections = true;
  }

  performPEXRequestToClosestPeer(peersRequested) {
    const dataChannel = this.getClosestOpenPEXDataChannel();
    if (dataChannel) {
      console.log(`Requesting ${peersRequested} additional peers via PEX`);
      try {
        this.sendPEXRequest(dataChannel, peersRequested);
      } catch (error) {
        console.error("Failed to send PEX request:", error);
      }
    } else {
      console.warn("No open PEX data channels available to send request");
    }
  }

  performPEXRequestToRandomPeer(peersRequested) {
    const dataChannel = this.getRandomOpenDataChannel();
    if (dataChannel) {
      console.log(`Requesting ${peersRequested} additional peers via PEX to random peer`);
      try {
        this.sendPEXRequest(dataChannel, peersRequested);
      } catch (error) {
        console.error("Failed to send PEX request:", error);
      }
    } else {
      console.warn("No open PEX data channels available to send request");
    }
  }

  sendPEXRequest(pexDataChannel, requestedPeersNum) {
    console.log("Sending PEX request");
    const requestMessage = {
      type: "request",
      maxNumberOfPeers: requestedPeersNum,
    };
    try {
      if (pexDataChannel.readyState !== "open") {
        throw new Error("PEX data channel is not open");
      }
      pexDataChannel.send(JSON.stringify(requestMessage));
    } catch (error) {
      console.error("Couldn’t send PEX request:", error);
    }
  }

  async shareConnectedPeers(pexDataChannel, message, userStore) {
    const maxNumberOfPeers = message.maxNumberOfPeers;
    const peersToShare = new Set();

    console.log(userStore);
    try {
      if (this.connections.size !== 0) {
        let count = 0;
        for (const peerId of this.connections.keys()) {
          if (count >= maxNumberOfPeers) {
            break;
          }
          const iceConnectionState = this.connections.get(peerId)?.iceConnectionState;
          if (iceConnectionState === "connected" || iceConnectionState === "completed") {
            const user = userStore.get(peerId);
            const peerDto = this.convertUserToPeerDTO(user);
            if (peerDto) {
              peersToShare.add(peerDto);
              count++;
            }
          }
        }
      }

      const answer = {
        type: "advertisement",
        peers: Array.from(peersToShare),
      };

      if (pexDataChannel.readyState !== "open") {
        console.warn("PEX data channel is not open, cannot send advertisement");
        return;
      }
      pexDataChannel.send(JSON.stringify(answer));
    } catch (err) {
      console.error("Error in shareConnectedPeers:", err);
    }
  }

  convertUserToPeerDTO(user) {
    if (!user) return null;
    return {
      peerId: user.peerId,
      publicKey: user.publicKey,
      age: user.age || 0,
      sex: user.sex || [0, 0, 0],
      searching: user.searching || [0, 0, 0],
      x: user.x || 0,
      y: user.y || 0,
      latitude: user.latitude || 0,
      longitude: user.longitude || 0
    };
  }

  // todo: share userstore
//   async tryToRestoreDHTConnections(peersToConnect) {
//     try {
//       const nodesInBuckets = this.dht.getAllNodes();
//       const nodeId = this.dht.nodeId;
//       let peersAttempted = 0;
//       for (const peer of nodesInBuckets) {
//         if (peersAttempted >= peersToConnect) {
//           break;
//         }
//         if (peer.id !== nodeId && !this.connections.has(peer.id)) {
//           const peerDTO = {
//             peerId: peer.id,
//             publicKey: userStore.get(peer.id)?.publicKey
//           };
//           if (peerDTO.publicKey) {
//             console.log(`Attempting connection to peer ${peer.id}`);
//             await this.initiateConnection(peerDTO, null, true);
//             peersAttempted++;
//           }
//         }
//       }
//     } catch (err) {
//       console.log(err);
//     }
//   }

  getClosestOpenPEXDataChannel() {
    const openChannels = Array.from(this.pexDataChannels.entries()).filter(
      ([_, channel]) => channel.readyState === "open"
    );
    const peerIds = openChannels.map(([peerId]) => peerId);
    this.dht.sortClosestToSelf(peerIds);
    if (openChannels.length === 0) {
      return null;
    }
    return openChannels[0]?.[1] || null;
  }

  getRandomOpenDataChannel() {
    const openChannels = Array.from(this.pexDataChannels.values()).filter(
      (channel) => channel.readyState === "open"
    );
    if (openChannels.length === 0) {
      return null;
    }
    const randomIndex = Math.floor(Math.random() * openChannels.length);
    return openChannels[randomIndex];
  }

  checkConnectionsAndConnect() {
    // if (this.filteredPeers.size < this.minConnections) {
    //   const peersNeeded = this.minConnections - this.filteredPeers.size;
    //   console.log(`Requesting ${peersNeeded} peers via PEX`);
    //   this.performPEXRequestToRandomPeer(peersNeeded);
    // }
  }

  filterPeer(peer) {
    return true;
  }

  handleNewPeers(receivedPeers, signalingDataChannel) {
    const tableOfPeers = [];
    if (Array.isArray(receivedPeers)) {
      receivedPeers.forEach((peerDto) => {
        const alreadyConnected = this.connections.has(peerDto.peerId);
        if (
          !tableOfPeers.includes(peerDto) &&
          !alreadyConnected &&
          peerDto.peerId !== this.dht.nodeId
        //   !this.blockedPeers.has(peerDto.peerId)
        ) {
          tableOfPeers.push(peerDto);
        }
      });
    }
    console.log("New peers received:", tableOfPeers);
    const filteredPeers = tableOfPeers.filter((peer) => this.filterPeer(peer));
    filteredPeers.forEach((peerDto) => {
    //   this.filteredPeers.add(peerDto);
      this.initiateConnection(peerDto, signalingDataChannel, false);
    });
    // Connect to peers that are not meant to be displayed just to keep minConnections
    if (this.connections.size < this.minConnections) {
      const peersNeeded = this.minConnections - this.connections.size;
      const unconnectedPeers = tableOfPeers.filter(
        (peer) =>
          !filteredPeers.some((filteredPeer) => filteredPeer.peerId === peer.peerId) &&
          !this.connections.has(peer.peerId)
      );
      for (let i = 0; i < peersNeeded && i < unconnectedPeers.length; i++) {
        this.initiateConnection(unconnectedPeers[i], signalingDataChannel, false);
      }
    }
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { ConnectionManager };