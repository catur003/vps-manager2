const express = require('express');
const config = require('../../config/config');
const database = require('../../database/database');
const notify = require('../../notify/notify');
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
  'discord_webhook_url',
  'telegram_bot_token',
  'telegram_chat_id',
  'ssl_auto_renew',
  'webhook_secret',
  'ai_base_url',
  'ai_api_key',
  'ai_model',
  'ai_model_filter',
  'additional_pm2_users',
  'cloudflare_api_token',
  'pg_root_user',
  'pg_root_password',
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
  const {
    db_root_password: dbPassword,
    pg_root_password: pgPassword,
    telegram_bot_token: telegramBotToken,
    webhook_secret: webhookSecret,
    ai_api_key: aiApiKey,
    cloudflare_api_token: cloudflareApiToken,
    api,
    github_accounts: githubAccounts,
    ...rest
  } = cfg;
  return {
    ...rest,
    hasDbPassword: Boolean(dbPassword),
    hasPgPassword: Boolean(pgPassword),
    hasTelegramBotToken: Boolean(telegramBotToken),
    hasWebhookSecret: Boolean(webhookSecret),
    hasAiApiKey: Boolean(aiApiKey),
    hasCloudflareApiToken: Boolean(cloudflareApiToken),
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

  // db_root_password diganti DUA-DUANYA sekaligus: config.json DAN MariaDB
  // nyata (via ALTER USER, autentikasi pakai password LAMA dari cfg saat
  // ini). Ini nyegah desync yang pernah kejadian - config.json nyimpen
  // password yang gak match kenyataan di server, jadi semua fitur database
  // di panel gagal konek walau kelihatannya "udah disimpan".
  if ('db_root_password' in updates) {
    const dbResult = database.changeRootPassword(updates.db_root_password);
    if (!dbResult.ok) {
      audit.recordEnd(auditId, { success: false, message: dbResult.errorMessage, durationMs: Date.now() - startedAt });
      return res.status(400).json({
        success: false,
        message: `Gagal ganti password di MariaDB (config TIDAK disimpan, biar gak desync): ${dbResult.errorMessage}`,
        code: 'DB_PASSWORD_CHANGE_FAILED',
      });
    }
  }

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

/**
 * POST /config/test-notify - kirim pesan test ke channel Discord/Telegram
 * yang lagi dikonfigurasi. Read-only terhadap sistem (gak ubah apa-apa),
 * cuma buat verifikasi kredensial notif bener sebelum dipakai beneran.
 */
router.post('/test-notify', async (req, res) => {
  const ACTION = 'config.testNotify';
  if (!guard(ACTION, res)) return;

  const cfg = config.loadConfig();
  if (!cfg.discord_webhook_url && !(cfg.telegram_bot_token && cfg.telegram_chat_id)) {
    return res.status(400).json({
      success: false,
      message: 'Belum ada Discord webhook atau Telegram bot/chat yang dikonfigurasi.',
      code: 'NO_NOTIFY_CHANNEL',
    });
  }

  const results = await notify.notify('🔔 Test notifikasi dari vps-manager dashboard — kalau kamu lihat ini, konfigurasinya berhasil!');
  const anyOk = results.some((r) => r.ok);
  res.json({
    success: anyOk,
    message: anyOk ? 'Test notifikasi terkirim.' : 'Gagal kirim ke semua channel yang dikonfigurasi.',
    data: { results },
  });
});

module.exports = router;
