const os = require('os');

/**
 * Get the primary local IPv4 address (Wi-Fi / LAN)
 */
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  const preferred = ['wlan0', 'wlp2s0', 'eth0', 'en0', 'Wi-Fi'];
  
  for (const name of preferred) {
    const iface = interfaces[name];
    if (iface) {
      for (const addr of iface) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  }

  // Fallback: any non-internal IPv4
  for (const name of Object.keys(interfaces)) {
    for (const addr of interfaces[name]) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = { getLocalIP, formatBytes };
