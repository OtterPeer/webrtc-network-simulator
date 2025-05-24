class ConnectionManager {
  constructor(connectionsRef, pexDataChannelsRef, dhtRef, userFilterRef, profilesToDisplayRef, displayedPeersRef, currentSwiperIndexRef, blockedPeersRef, setPeers, initiateConnection, notifyProfilesChange) {
    this.connectionsRef = connectionsRef;
    this.pexDataChannelsRef = pexDataChannelsRef;
    this.dhtRef = dhtRef;
    this.userFilterRef = userFilterRef;
    this.profilesToDisplayRef = profilesToDisplayRef;
    this.displayedPeersRef = displayedPeersRef;
    this.currentSwiperIndexRef = currentSwiperIndexRef;
    this.blockedPeersRef = blockedPeersRef;
    this.setPeers = setPeers;
    this.initiateConnection = initiateConnection;
    this.notifyProfilesChange = notifyProfilesChange;
    this.filteredPeersReadyToDisplay = new Set();
  }

  async handleNewPeers(receivedPeers) {
    const filteredPeers = receivedPeers.filter(peer => !this.blockedPeersRef.current.has(peer.peerId) && !this.connectionsRef.has(peer.peerId));
    for (const peer of filteredPeers) {
      if (this.connectionsRef.size < 100) {
        this.filteredPeersReadyToDisplay.add(peer);
        await this.initiateConnection(peer);
      }
    }
  }
}

module.exports = { ConnectionManager };