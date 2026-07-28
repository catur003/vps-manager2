const express = require('express');
const config = require('../../config/config');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();

// Field yang aman diedit lewat form "umum" di app/CLI. Sengaja whitelist,
// bukan terima body mentah - biar client gak bisa nyelipin field lain
// (mis. langsung nimpa api.key_hash atau github_accounts lewat endpoint ini).
const EDITABLE_FIELDS = [
  'deploy_user',
  'nginx_user',
  'default_folder',
  'git_branch',
  'starting_port',
  'nginx_conf_dir',
  'nginx_binary',
  'certbot_webroot',
  'certbot_email',
  'db_root_user',
  'db_root_password',
  'backup_dir',
  'backup_retention_days',
  'nginx_log_dir',
];

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * Buang/mask field sensitif sebelum dikirim ke client. `db_root_password`
 * TIDAK PERNAH dikirim balik mentah - cuma flag `hasDbPassword`. Sama
 * prinsipnya kayak `api.key_hash` yang emang dari awal gak pernah dibalikin.
 */
function maskConfig(cfg) {
  const { db_root_password: dbPassword, api, github_accounts: githubAccounts, ...rest } = cfg;
  return {
    ...rest,
    hasDbPassword: Boolean(dbPassword),
    api: { port: api?.port },
    githubAccountsCount: (githubAccounts || []).length,
  };
}

/**
 * GET /config - baca konfigurasi umum tool (bukan config per-project).
 * Read-only, kredensial di-mask (lihat maskConfig()).
 */
router.get('/', (req, res) => {
  const ACTION = 'config.view';
  if (!guard(ACTION, res)) return;

  const cfg = config.loadConfig();
  res.json({ success: true, message: 'OK', data: maskConfig(cfg) });
});

/**
 * PUT /config - update field umum. WAJIB confirm:true (lihat commandPolicy) -
 * salah isi path (nginx_conf_dir, dll) bisa bikin fitur lain rusak total.
 * Cuma field di EDITABLE_FIELDS yang diterima, sisanya diabaikan.
 */
router.put('/', (req, res) => {
  const ACTION = 'config.update';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const body = req.body || {};
  if (policy.confirmRequired && body.confirm !== true) {
    return res.status(400).json({
      success: false,
      message: 'Perubahan konfigurasi umum bisa berdampak ke semua fitur lain. Kirim ulang dengan { "confirm": true } kalau yakin.',
      code: 'CONFIRM_REQUIRED',
    });
  }

  const updates = {};
  for (const field of EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      updates[field] = body[field];
    }
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ success: false, message: 'Tidak ada field valid yang dikirim.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  // params di-audit TANPA db_root_password mentah - audit.redact() sudah
  // handle ini di level lain, tapi kita jaga dari sini juga (defense-in-depth).
  const auditParams = { ...updates };
  if ('db_root_password' in auditParams) auditParams.db_root_password = '(redacted)';
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: auditParams });

  const cfg = config.loadConfig();
  const merged = { ...cfg, ...updates };
  config.saveConfig(merged);

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.json({ success: true, message: 'Konfigurasi disimpan.', data: maskConfig(merged) });
});

/**
 * GET /config/github - daftar akun GitHub tersimpan. Token TIDAK PERNAH
 * dikirim balik, cuma label + username - biar aman ditampilin di UI list.
 */
router.get('/github', (req, res) => {
  const ACTION = 'config.github.list';
  if (!guard(ACTION, res)) return;

  const accounts = config.listGithubAccounts().map(({ label, username }) => ({ label, username }));
  res.json({ success: true, message: 'OK', data: { accounts } });
});

/**
 * POST /config/github - tambah/replace akun GitHub (label sama = ditimpa).
 * Bukan destruktif ke data lain, jadi gak perlu confirm eksplisit.
 */
router.post('/github', (req, res) => {
  const ACTION = 'config.github.add';
  if (!guard(ACTION, res)) return;

  const { label, username, token } = req.body || {};
  if (!label || typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ success: false, message: 'label wajib diisi.', code: 'INVALID_INPUT' });
  }
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ success: false, message: 'username wajib diisi.', code: 'INVALID_INPUT' });
  }
  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ success: false, message: 'token (PAT) wajib diisi.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { label, username, token: '(redacted)' } });
  config.addGithubAccount({ label: label.trim(), username: username.trim(), token: token.trim() });
  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });

  res.json({ success: true, message: `Akun "${label}" tersimpan.` });
});

/**
 * DELETE /config/github/:label - hapus akun GitHub tersimpan. WAJIB
 * confirm:true - repo yang masih pakai token ini via remote URL TIDAK ikut
 * ke-update (perlu Update Kredensial GitHub manual per-project kalau perlu).
 */
router.delete('/github/:label', (req, res) => {
  const ACTION = 'config.github.remove';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { label } = req.params;
  const { confirm } = req.body || {};
  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Akun "${label}" akan dihapus dari config. Kirim ulang dengan { "confirm": true } kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { label } });
  config.removeGithubAccount(label);
  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });

  res.json({ success: true, message: `Akun "${label}" dihapus.` });
});

module.exports = router;
