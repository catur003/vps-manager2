const express = require('express');
const docker = require('../../docker/docker');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

function requireValidName(req, res) {
  const { name } = req.params;
  if (!docker.isValidContainerName(name)) {
    res.status(400).json({ success: false, message: 'Nama container tidak valid.', code: 'INVALID_INPUT' });
    return null;
  }
  return name;
}

/**
 * List semua container (jalan + berhenti) - read-only.
 */
router.get('/', (req, res) => {
  const ACTION = 'docker.list';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });

  const result = docker.listContainers();
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(500).json({ success: false, message: result.errorMessage, code: 'DOCKER_LIST_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { containers: result.containers } });
});

router.get('/stats', (req, res) => {
  const ACTION = 'docker.stats';
  if (!guard(ACTION, res)) return;
  const result = docker.getStats();
  if (!result.ok) return res.status(500).json({ success: false, message: result.errorMessage, code: 'DOCKER_STATS_FAILED' });
  res.json({ success: true, message: 'OK', data: { stats: result.stats } });
});

router.get('/:name/logs', (req, res) => {
  const ACTION = 'docker.logs';
  if (!guard(ACTION, res)) return;
  const name = requireValidName(req, res);
  if (!name) return;

  let lines = parseInt(req.query.lines, 10);
  if (!Number.isFinite(lines) || lines <= 0) lines = 100;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name, lines } });

  const result = docker.logs(name, lines);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'DOCKER_LOGS_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { name, output: result.output } });
});

/**
 * POST / - deploy container BARU dari image (docker run -d). Beda dari
 * start/stop/restart di bawah yang cuma ngontrol container yang SUDAH ada.
 */
router.post('/', (req, res) => {
  const ACTION = 'docker.run';
  if (!guard(ACTION, res)) return;

  const { image, name, ports, envVars, restartPolicy, memoryLimit } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ success: false, message: 'image wajib diisi.', code: 'INVALID_INPUT' });
  }
  if (!docker.isValidContainerName(name)) {
    return res.status(400).json({ success: false, message: 'Nama container tidak valid.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { image, name, ports, restartPolicy, memoryLimit } });

  const result = docker.runContainer({ image, name, ports, envVars, restartPolicy, memoryLimit });
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'DOCKER_RUN_FAILED' });
  }
  res.status(201).json({ success: true, message: `Container "${name}" berhasil dijalankan.`, data: result });
});

router.delete('/:name', (req, res) => {
  const ACTION = 'docker.remove';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  const name = requireValidName(req, res);
  if (!name) return;
  if (policy.confirmRequired && req.body?.confirm !== true) {
    return res.status(400).json({ success: false, message: `Container "${name}" akan dihapus PERMANEN. Kirim ulang dengan { "confirm": true }.`, code: 'CONFIRM_REQUIRED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name } });
  const result = docker.remove(name);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'DOCKER_REMOVE_FAILED' });
  res.json({ success: true, message: `Container "${name}" dihapus.` });
});

router.post('/:name/start', (req, res) => {
  const ACTION = 'docker.start';
  if (!guard(ACTION, res)) return;
  const name = requireValidName(req, res);
  if (!name) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name } });

  const result = docker.start(name);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'DOCKER_START_FAILED' });
  }
  res.json({ success: true, message: `Container "${name}" di-start.` });
});

router.post('/:name/stop', (req, res) => {
  const ACTION = 'docker.stop';
  if (!guard(ACTION, res)) return;
  const name = requireValidName(req, res);
  if (!name) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name } });

  const result = docker.stop(name);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'DOCKER_STOP_FAILED' });
  }
  res.json({ success: true, message: `Container "${name}" di-stop.` });
});

router.post('/:name/restart', (req, res) => {
  const ACTION = 'docker.restart';
  if (!guard(ACTION, res)) return;
  const name = requireValidName(req, res);
  if (!name) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name } });

  const result = docker.restart(name);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'DOCKER_RESTART_FAILED' });
  }
  res.json({ success: true, message: `Container "${name}" di-restart.` });
});

module.exports = router;
