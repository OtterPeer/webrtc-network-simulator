const EventEmitter = require('events');
EventEmitter.defaultMaxListeners = 1000;

const visualizationEmitter = new EventEmitter();

module.exports = { visualizationEmitter };