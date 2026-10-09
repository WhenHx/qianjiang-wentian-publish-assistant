const fs = require('node:fs');
const path = require('node:path');
const { SimulatedPlatformAdapter } = require('./simulatedAdapter');
const { ConfigurableCdpAdapter } = require('./configurableCdpAdapter');

function capabilities() {
  return JSON.parse(fs.readFileSync(path.resolve('config/platform-capabilities.json'), 'utf8'));
}

function createPlatformAdapter(platform, context) {
  if (context.automationMode === 'simulated') return new SimulatedPlatformAdapter({ ...context, platform });
  return new ConfigurableCdpAdapter({ ...context, platform });
}

module.exports = { createPlatformAdapter, capabilities };