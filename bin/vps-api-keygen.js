#!/usr/bin/env node

const config = require('../src/config/config');
const logger = require('../src/utils/logger');

const existingHash = config.loadConfig().api?.key_hash;
if (existingHash) {
  logger.warn('API key udah pernah di-generate sebelumnya. Lanjut = key LAMA langsung invalid, semua client (bot/app) yang masih pakai key lama bakal ke-reject.');
}

const key = config.generateApiKey();

logger.title('API Key Baru');
logger.card(
  'SIMPAN SEKARANG - GAK BAKAL DITAMPILIN LAGI SETELAH INI',
  [key, '', 'Pasang di client sebagai header:', `Authorization: Bearer ${key}`],
  { color: 'red' }
);
