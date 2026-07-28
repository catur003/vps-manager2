const config = require('../../config/config');

/**
 * Cek header "Authorization: Bearer <api_key>" cocok sama hash tersimpan
 * (lihat config.generateApiKey/verifyApiKey). Dipasang di server.js buat
 * SEMUA route kecuali /health.
 */
function apiKeyAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;

  if (!config.verifyApiKey(token)) {
    return res.status(401).json({
      success: false,
      message: 'API key tidak valid atau tidak disertakan.',
      code: 'UNAUTHORIZED',
    });
  }
  next();
}

module.exports = { apiKeyAuth };
