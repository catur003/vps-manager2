#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const { createServer } = require('../src/api/server');
const config = require('../src/config/config');
const authStore = require('../src/auth/authStore');
const logger = require('../src/utils/logger');
const { attachTerminalServer } = require('../src/api/terminal');
const { attachDockerExecServer } = require('../src/api/dockerExec');

const cfg = config.loadConfig();
const port = (cfg.api && cfg.api.port) || 4001;

const authStatus = authStore.status();
if ((!cfg.api || !cfg.api.key_hash) && !authStatus.initialized && !authStatus.setupEnabled) {
  logger.error('Autentikasi belum disiapkan. Dari folder repo jalankan: node bin/vps-manager.js setup-token regenerate');
  process.exit(1);
}

const app = createServer();

// Listener HTTP internal selalu loopback untuk Nginx/domain.
const httpServer = app.listen(port, '127.0.0.1', () => {
  logger.success(`VPS Manager API jalan di http://127.0.0.1:${port} (localhost only)`);
});
attachTerminalServer(httpServer);
attachDockerExecServer(httpServer);

// Fresh install tanpa domain dapat membuka listener HTTPS publik terpisah
// dengan sertifikat self-signed. Port internal dan publik wajib berbeda.
const direct = cfg.api?.direct_https || {};
if (direct.enabled) {
  const publicPort = Number(cfg.api?.public_port || 4001);
  if (publicPort === port) {
    logger.error('Konfigurasi invalid: api.public_port harus berbeda dari api.port internal.');
    process.exit(1);
  }
  if (!direct.key_path || !direct.cert_path) {
    logger.error('Direct HTTPS aktif tapi path key/certificate belum diisi.');
    process.exit(1);
  }
  const httpsServer = https.createServer({
    key: fs.readFileSync(direct.key_path),
    cert: fs.readFileSync(direct.cert_path),
  }, app);
  httpsServer.listen(publicPort, '0.0.0.0', () => {
    const publicUrl = cfg.api.public_url || ('https://IP_VPS:' + publicPort);
    logger.success('Direct HTTPS aktif di ' + publicUrl);
    logger.warn('Sertifikat awal self-signed. Cocokkan fingerprint dengan output installer sebelum melewati peringatan browser.');
  });
  attachTerminalServer(httpsServer);
  attachDockerExecServer(httpsServer);
}
