const fs = require('fs');
const express = require('express');
const monitor = require('../../monitor/monitor');
const bandwidth = require('../../monitor/bandwidth');
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

router.get('/bandwidth', (req, res) => {
  const BW_ACTION = 'monitor.bandwidth';
  if (!commandPolicy.isExposed(BW_ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: BW_ACTION, ip: req.ip, params: {} });
  try {
    const summary = bandwidth.getSummary();
    audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
    res.json({ success: true, message: 'OK', data: summary });
  } catch (err) {
    audit.recordEnd(auditId, { success: false, message: err.message, durationMs: Date.now() - startedAt });
    res.status(500).json({ success: false, message: 'Gagal ambil data bandwidth.', code: 'BANDWIDTH_FAILED' });
  }
});

router.get('/server-info', (req, res) => {
  const ACTION = 'monitor.serverInfo';
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  try {
    res.json({ success: true, message: 'OK', data: monitor.getServerInfo() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal ambil info server.', code: 'SERVER_INFO_FAILED' });
  }
});

/**
 * Aktivitas terbaru buat panel "Recent Activity" di Overview - baca
 * `data/audit.log` yang REAL (bukan data fake), ambil N baris terakhir,
 * cuma event "end" (biar 1 baris = 1 aksi selesai, bukan start+end
 * terpisah), params sudah ke-redact dari audit.js sejak ditulis.
 */
router.get('/recent-activity', (req, res) => {
  const ACTION = 'monitor.recentActivity';
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const limit = Math.min(parseInt(req.query.limit, 10) || 15, 100);
  try {
    if (!fs.existsSync(audit.AUDIT_LOG_PATH)) {
      return res.json({ success: true, message: 'OK', data: { events: [] } });
    }
    const lines = fs.readFileSync(audit.AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
    const starts = new Map();
    const events = [];
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.event === 'start') starts.set(entry.auditId, entry);
      else if (entry.event === 'end') {
        const start = starts.get(entry.auditId);
        events.push({
          action: start?.action || 'unknown',
          ip: start?.ip || null,
          success: entry.success,
          message: entry.message,
          at: entry.at,
        });
      }
    }
    res.json({ success: true, message: 'OK', data: { events: events.slice(-limit).reverse() } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal baca activity log.', code: 'RECENT_ACTIVITY_FAILED' });
  }
});

router.get('/check-port/:port', (req, res) => {
  const ACTION = 'system.checkPort';
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const result = monitor.checkPort(req.params.port);
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'CHECK_PORT_FAILED' });
  res.json({ success: true, message: 'OK', data: result });
});

module.exports = router;
