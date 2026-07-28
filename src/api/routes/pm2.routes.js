const express = require('express');
const pm2 = require('../../pm2/pm2');
const registry = require('../../registry/registry');
const config = require('../../config/config');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const { validateName } = require('../../menu/helpers');

const router = express.Router();

/**
 * Resolusi `owner` (deploy_user) dari `name` lewat registry - BUKAN dari
 * request body. Sama seperti CLI (menu selalu pilih app dari hasil
 * pm2.listApps(), gak pernah ketik owner manual), supaya request API gak
 * bisa nyuruh proses ini jalanin `sudo -u <owner apa aja>` (command
 * injection lewat parameter owner kalau itu dipercaya dari client).
 * Kalau project gak ada di registry, coba cari di pm2.listApps() (app yang
 * mungkin di-pm2-start manual di luar alur deploy tool ini).
 */
function resolveOwner(name) {
  const project = registry.findProject(name);
  if (project) return project.deploy_user || config.loadConfig().deploy_user;

  const { apps } = pm2.listAppsIncludingUnstarted();
  const match = (apps || []).find((a) => a.name === name);
  return match ? match.owner : null;
}

function requireValidName(req, res) {
  const { name } = req.params;
  const check = validateName(name);
  if (check !== true) {
    res.status(400).json({ success: false, message: check, code: 'INVALID_INPUT' });
    return null;
  }
  const owner = resolveOwner(name);
  if (!owner) {
    res.status(404).json({
      success: false,
      message: `App "${name}" tidak ditemukan di registry maupun PM2.`,
      code: 'APP_NOT_FOUND',
    });
    return null;
  }
  return owner;
}

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * List semua app PM2 (termasuk yang terdaftar di registry tapi belum
 * pernah di-start) - read-only.
 */
router.get('/', (req, res) => {
  const ACTION = 'pm2.list';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });

  const result = pm2.listAppsIncludingUnstarted();
  audit.recordEnd(auditId, { success: result.ok, message: result.error || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(500).json({ success: false, message: result.error, code: 'PM2_LIST_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { apps: result.apps, warnings: result.warnings || [] } });
});

/**
 * Detail satu app (`pm2 describe`) - read-only.
 */
router.get('/:name', (req, res) => {
  const ACTION = 'pm2.detail';
  if (!guard(ACTION, res)) return;
  const owner = requireValidName(req, res);
  if (!owner) return;
  const { name } = req.params;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name } });

  const result = pm2.detail(name, owner);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'PM2_DETAIL_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { name, owner, output: result.output } });
});

/**
 * Log app (`pm2 logs --nostream`) - read-only. `lines` lewat query string,
 * dibatasi 1-1000 biar gak dipakai buat narik log segede-gedenya.
 */
router.get('/:name/logs', (req, res) => {
  const ACTION = 'pm2.logs';
  if (!guard(ACTION, res)) return;
  const owner = requireValidName(req, res);
  if (!owner) return;
  const { name } = req.params;

  let lines = parseInt(req.query.lines, 10);
  if (!Number.isFinite(lines) || lines <= 0) lines = 50;
  lines = Math.min(lines, 1000);

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name, lines } });

  const result = pm2.logs(name, owner, lines);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'PM2_LOGS_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { name, owner, lines, output: result.output } });
});

/**
 * Start app. Kalau belum pernah start sama sekali, pm2.start() otomatis
 * fallback ke full command pakai data registry (path & port) - lihat
 * komentar di pm2.js.
 */
router.post('/:name/start', (req, res) => {
  const ACTION = 'pm2.start';
  if (!guard(ACTION, res)) return;
  const owner = requireValidName(req, res);
  if (!owner) return;
  const { name } = req.params;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name, owner } });

  const result = pm2.start(name, owner);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || result.output || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'PM2_START_FAILED' });
  }
  res.json({ success: true, message: `App "${name}" berhasil di-start.`, data: { output: result.output } });
});

router.post('/:name/stop', (req, res) => {
  const ACTION = 'pm2.stop';
  if (!guard(ACTION, res)) return;
  const owner = requireValidName(req, res);
  if (!owner) return;
  const { name } = req.params;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name, owner } });

  const result = pm2.stop(name, owner);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'PM2_STOP_FAILED' });
  }
  res.json({ success: true, message: `App "${name}" berhasil di-stop.`, data: { output: result.output } });
});

router.post('/:name/restart', (req, res) => {
  const ACTION = 'pm2.restart';
  if (!guard(ACTION, res)) return;
  const owner = requireValidName(req, res);
  if (!owner) return;
  const { name } = req.params;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name, owner } });

  const result = pm2.restart(name, owner);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'PM2_RESTART_FAILED' });
  }
  res.json({ success: true, message: `App "${name}" berhasil di-restart.`, data: { output: result.output } });
});

/**
 * Hapus app dari PM2 (proses & entry-nya, BUKAN file project). Bisa bikin
 * app langsung down kalau dihapus tanpa sengaja, jadi WAJIB confirm:true -
 * sama seperti database.drop.
 */
router.delete('/:name', (req, res) => {
  const ACTION = 'pm2.delete';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const owner = requireValidName(req, res);
  if (!owner) return;
  const { name } = req.params;
  const { confirm } = req.body || {};

  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Aksi ini menghapus app "${name}" dari PM2 (proses berhenti, app jadi down). Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name, owner } });

  const result = pm2.deleteApp(name, owner);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'PM2_DELETE_FAILED' });
  }
  res.json({ success: true, message: `App "${name}" berhasil dihapus dari PM2.`, data: { output: result.output } });
});

/**
 * Simpan startup list PM2 (`pm2 save`) buat SEMUA deploy_user yang relevan
 * (bukan cuma satu) - sama seperti tombol "Save Startup" di menu CLI.
 */
router.post('/save-startup', (req, res) => {
  const ACTION = 'pm2.saveStartup';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });

  const users = pm2.getRelevantUsers();
  const results = users.map((user) => ({ user, ...pm2.saveStartup(user) }));
  const anyFailed = results.some((r) => !r.ok);

  audit.recordEnd(auditId, { success: !anyFailed, message: 'OK', durationMs: Date.now() - startedAt });

  res.status(anyFailed ? 207 : 200).json({
    success: !anyFailed,
    message: anyFailed ? 'Sebagian user gagal disimpan, cek data.results.' : 'Startup list berhasil disimpan untuk semua user.',
    data: { results },
  });
});

module.exports = router;
