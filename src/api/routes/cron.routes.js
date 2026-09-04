const express = require('express');
const cron = require('../../cron/cron');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const config = require('../../config/config');

const router = express.Router();

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

function resolveUser(req) {
  return req.query.user || req.body?.user || config.loadConfig().deploy_user;
}

router.get('/', (req, res) => {
  const ACTION = 'cron.list';
  if (!guard(ACTION, res)) return;
  const user = resolveUser(req);
  const result = cron.list(user);
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'CRON_LIST_FAILED' });

  const lastRuns = cron.getLastRuns(user);
  const entries = result.entries.map((entry) => ({
    ...entry,
    lastRun: entry.jobId ? lastRuns[entry.jobId] || null : null,
  }));
  res.json({ success: true, message: 'OK', data: { user, entries } });
});

router.get('/:index/history', (req, res) => {
  const ACTION = 'cron.history';
  if (!guard(ACTION, res)) return;
  const user = resolveUser(req);
  const index = parseInt(req.params.index, 10);
  const listResult = cron.list(user);
  if (!listResult.ok) return res.status(400).json({ success: false, message: listResult.errorMessage, code: 'CRON_LIST_FAILED' });
  const entry = listResult.entries.find((e) => e.index === index);
  if (!entry) return res.status(404).json({ success: false, message: 'Cron job tidak ditemukan.', code: 'CRON_NOT_FOUND' });
  if (!entry.jobId) return res.json({ success: true, message: 'OK', data: { runs: [] } });

  const result = cron.getHistory(user, entry.jobId, 20);
  res.json({ success: true, message: 'OK', data: { runs: result.runs } });
});

router.post('/', (req, res) => {
  const ACTION = 'cron.add';
  if (!guard(ACTION, res)) return;
  const user = resolveUser(req);
  const { schedule, command, name } = req.body || {};
  if (!schedule || !command) {
    return res.status(400).json({ success: false, message: 'schedule dan command wajib diisi.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { user, schedule, command, name } });
  const result = cron.add(user, schedule, command, name);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'CRON_ADD_FAILED' });
  res.status(201).json({ success: true, message: 'Cron job ditambahkan.' });
});

router.put('/:index', (req, res) => {
  const ACTION = 'cron.update';
  if (!guard(ACTION, res)) return;
  const user = resolveUser(req);
  const index = parseInt(req.params.index, 10);
  const { schedule, command, name } = req.body || {};
  if (!schedule || !command || Number.isNaN(index)) {
    return res.status(400).json({ success: false, message: 'schedule dan command wajib diisi.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { user, index, schedule, command, name } });
  const result = cron.update(user, index, schedule, command, name);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'CRON_UPDATE_FAILED' });
  res.json({ success: true, message: 'Cron job diupdate.' });
});

router.post('/:index/toggle', (req, res) => {
  const ACTION = 'cron.toggle';
  if (!guard(ACTION, res)) return;
  const user = resolveUser(req);
  const index = parseInt(req.params.index, 10);

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { user, index } });
  const result = cron.toggle(user, index);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'CRON_TOGGLE_FAILED' });
  res.json({ success: true, message: 'Status cron job diubah.' });
});

router.delete('/:index', (req, res) => {
  const ACTION = 'cron.remove';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  const user = resolveUser(req);
  const index = parseInt(req.params.index, 10);
  if (policy.confirmRequired && req.body?.confirm !== true) {
    return res.status(400).json({ success: false, message: 'Kirim ulang dengan { "confirm": true } untuk hapus cron job ini.', code: 'CONFIRM_REQUIRED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { user, index } });
  const result = cron.remove(user, index);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'CRON_REMOVE_FAILED' });
  res.json({ success: true, message: 'Cron job dihapus.' });
});

module.exports = router;
