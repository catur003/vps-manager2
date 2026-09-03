const express = require('express');
const redis = require('../../redis/redis');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();
const ACTION = 'redis.status';

router.get('/status', (req, res) => {
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = redis.getStatus();
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    if (result.notInstalled) {
      return res.json({ success: true, message: result.errorMessage, data: { notInstalled: true } });
    }
    return res.status(500).json({ success: false, message: result.errorMessage, code: 'REDIS_STATUS_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: result });
});

module.exports = router;
