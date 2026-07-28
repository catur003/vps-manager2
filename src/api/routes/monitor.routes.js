const express = require('express');
const monitor = require('../../monitor/monitor');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();
const ACTION = 'monitor.getStatus';

router.get('/', (req, res) => {
  // default-deny: kalau action ini gak terdaftar di commandPolicy, tolak.
  // Jaring pengaman kalau ke depan lupa daftarin action baru di sana.
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });

  try {
    const status = monitor.getStatus();
    audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
    res.json({ success: true, message: 'OK', data: status });
  } catch (err) {
    audit.recordEnd(auditId, { success: false, message: err.message, durationMs: Date.now() - startedAt });
    res.status(500).json({ success: false, message: 'Gagal ambil status server.', code: 'MONITOR_FAILED' });
  }
});

module.exports = router;
