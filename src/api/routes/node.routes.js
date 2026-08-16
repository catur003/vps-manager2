const express = require('express');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const node = require('../../node/node');
const registry = require('../../registry/registry');
const config = require('../../config/config');

const router = express.Router();

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * User yang mau dicek/diubah versi Node-nya. Default ke deploy_user global
 * (kebanyakan VPS cuma pakai satu deploy user buat semua project) - tapi
 * bisa di-override lewat query/body `user` kalau ada project dengan
 * deploy_user berbeda.
 */
function resolveUser(req) {
  return req.query.user || req.body?.user || config.loadConfig().deploy_user;
}

/**
 * GET /node/projects - daftar project di registry + versi Node yang lagi
 * di-pin (kalau ada). Dipisah dari GET /project (yang isinya env/delete,
 * scope beda) biar layar Node Manager di app cukup 1 request buat tau
 * "project mana pin ke versi apa" tanpa perlu gabung-gabung data dari
 * endpoint lain.
 */
router.get('/projects', (req, res) => {
  if (!guard('node.list', res)) return; // read-only, numpang di policy node.list yang udah ada
  const projects = registry.listProjects().map((p) => ({
    name: p.name,
    deploy_user: p.deploy_user || config.loadConfig().deploy_user,
    node_version: p.node_version || null,
  }));
  res.json({ success: true, message: 'OK', data: projects });
});

/** GET /node/versions?user=www - daftar versi Node terinstall + current/default. */
router.get('/versions', (req, res) => {
  if (!guard('node.list', res)) return;
  const user = resolveUser(req);
  const result = node.listInstalled(user);
  res.json({ success: true, message: result.ok ? 'OK' : result.errorMessage, data: { user, ...result } });
});

/** POST /node/versions/install { version, user? } - install versi baru (auto-install nvm dulu kalau belum ada). */
router.post('/versions/install', (req, res) => {
  const ACTION = 'node.install';
  if (!guard(ACTION, res)) return;

  const { version } = req.body || {};
  const user = resolveUser(req);
  if (!version || typeof version !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Field "version" wajib diisi (mis. "20.11.0", "18", atau "lts/*").',
      code: 'INVALID_INPUT',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { version, user } });
  const result = node.installVersion(user, version);
  audit.recordEnd(auditId, {
    success: result.ok,
    message: result.ok ? 'OK' : result.errorMessage,
    durationMs: Date.now() - startedAt,
  });

  if (!result.ok) {
    return res.status(500).json({ success: false, message: result.errorMessage, code: 'NODE_INSTALL_FAILED' });
  }
  res.json({
    success: true,
    message: `Node ${version} berhasil diinstall untuk user "${user}".`,
    data: { user, ...node.listInstalled(user) },
  });
});

/** DELETE /node/versions/:version?user=www - uninstall versi Node. */
router.delete('/versions/:version', (req, res) => {
  const ACTION = 'node.uninstall';
  if (!guard(ACTION, res)) return;

  if (req.body?.confirm !== true) {
    return res.status(400).json({
      success: false,
      message: 'Aksi ini butuh konfirmasi eksplisit. Kirim { "confirm": true } di body.',
      code: 'CONFIRMATION_REQUIRED',
    });
  }

  const user = resolveUser(req);
  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { version: req.params.version, user } });
  const result = node.uninstallVersion(user, req.params.version);
  audit.recordEnd(auditId, {
    success: result.ok,
    message: result.ok ? 'OK' : result.errorMessage,
    durationMs: Date.now() - startedAt,
  });

  if (!result.ok) {
    return res.status(500).json({ success: false, message: result.errorMessage, code: 'NODE_UNINSTALL_FAILED' });
  }
  res.json({ success: true, message: `Node ${req.params.version} dihapus untuk user "${user}".` });
});

/** POST /node/versions/default { version, user? } - ganti versi default nvm user tsb. */
router.post('/versions/default', (req, res) => {
  const ACTION = 'node.setDefault';
  if (!guard(ACTION, res)) return;

  const { version } = req.body || {};
  const user = resolveUser(req);
  if (!version) {
    return res.status(400).json({ success: false, message: 'Field "version" wajib diisi.', code: 'INVALID_INPUT' });
  }

  const result = node.setDefault(user, version);
  if (!result.ok) {
    return res.status(500).json({ success: false, message: result.errorMessage, code: 'NODE_SET_DEFAULT_FAILED' });
  }
  res.json({ success: true, message: `Versi default Node untuk user "${user}" sekarang ${version}.` });
});

/**
 * POST /node/project/:name { version } - pin versi Node KHUSUS satu project
 * (override dari default nvm). Kirim `version: null`/kosong buat balikin ke
 * default sistem lagi. Disimpan di registry (`project.node_version`), baru
 * beneran kepakai pas app di-(re)start - lihat pm2.js `start()`.
 */
router.post('/project/:name', (req, res) => {
  const ACTION = 'node.setProjectVersion';
  if (!guard(ACTION, res)) return;

  const { version } = req.body || {};
  const project = registry.findProject(req.params.name);
  if (!project) {
    return res.status(404).json({ success: false, message: `Project "${req.params.name}" tidak ditemukan.`, code: 'NOT_FOUND' });
  }

  if (version) {
    const binDir = node.resolveBinDir(project.deploy_user, version);
    if (!binDir) {
      return res.status(400).json({
        success: false,
        message: `Versi Node "${version}" belum terinstall untuk user "${project.deploy_user}". Install dulu lewat POST /node/versions/install.`,
        code: 'NODE_VERSION_NOT_FOUND',
      });
    }
  }

  let updated;
  try {
    updated = registry.updateProject(req.params.name, { node_version: version || undefined });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, code: 'UPDATE_FAILED' });
  }

  res.json({
    success: true,
    message: version
      ? `Project "${req.params.name}" sekarang pakai Node ${version}. Restart app-nya (Delete lalu Start lagi di menu PM2) supaya kepakai.`
      : `Project "${req.params.name}" kembali pakai versi Node default sistem. Restart app-nya biar kepakai.`,
    data: updated,
  });
});

module.exports = router;
