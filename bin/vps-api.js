#!/usr/bin/env node

const { createServer } = require('../src/api/server');
const config = require('../src/config/config');
const logger = require('../src/utils/logger');

const cfg = config.loadConfig();
const port = (cfg.api && cfg.api.port) || 4001;

if (!cfg.api || !cfg.api.key_hash) {
  logger.error('API key belum di-generate. Jalankan dulu: node bin/vps-api-keygen.js');
  process.exit(1);
}

const app = createServer();

// Bind ke 127.0.0.1 SAJA - API ini gak pernah expose port langsung ke
// internet. Akses dari luar (bot Telegram/mobile/web GUI) wajib lewat
// Nginx reverse proxy + SSL (pakai nginx.js/ssl.js yang udah ada), bukan
// nembak port ini langsung.
app.listen(port, '127.0.0.1', () => {
  logger.success(`VPS Manager API jalan di http://127.0.0.1:${port} (localhost only)`);
  logger.info('Buat diakses dari luar: pasang reverse proxy + SSL lewat Nginx Manager, JANGAN expose port ini langsung.');
});
