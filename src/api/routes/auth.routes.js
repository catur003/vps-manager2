const express = require('express');
const rateLimit = require('express-rate-limit');
const authStore = require('../../auth/authStore');
const config = require('../../config/config');
const audit = require('../audit');

const router = express.Router();
function createAttemptLimiter(max = 10) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    // Request sukses tidak boleh menghabiskan jatah percobaan auth.
    skipSuccessfulRequests: true,
    message: { success: false, message: 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.', code: 'TOO_MANY_ATTEMPTS' },
  });
}

// Store dipisah supaya kegagalan login tidak memblokir pengelolaan API key
// dari sesi admin yang sudah sah (dan sebaliknya).
const setupLimiter = createAttemptLimiter();
const loginLimiter = createAttemptLimiter();
const sensitiveActionLimiter = createAttemptLimiter();

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}

function requireSession(req, res, csrf = false) {
  const csrfToken = csrf ? req.get('x-csrf-token') : null;
  if (csrf && !csrfToken) { res.status(403).json({ success: false, message: 'CSRF token tidak tersedia.', code: 'CSRF_REQUIRED' }); return null; }
  const session = authStore.verifySession(authStore.getSessionToken(req), csrfToken);
  if (!session) res.status(401).json({ success: false, message: 'Session tidak valid atau sudah berakhir.', code: 'UNAUTHORIZED' });
  return session;
}

router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, message: 'OK', data: authStore.status() });
});

router.post('/setup', setupLimiter, (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ success: false, message: 'Origin request tidak valid.', code: 'INVALID_ORIGIN' });
  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: 'auth.setup', ip: req.ip, params: { username: req.body?.username } });
  try {
    const { token, username, password, passwordConfirm } = req.body || {};
    if (password !== passwordConfirm) {
      const err = new Error('Konfirmasi password tidak sama.');
      err.code = 'PASSWORD_MISMATCH';
      throw err;
    }
    const admin = authStore.createAdmin({ token, username, password });
    audit.recordEnd(auditId, { success: true, message: 'Administrator dibuat.', durationMs: Date.now() - startedAt });
    res.status(201).json({ success: true, message: 'Administrator berhasil dibuat. Silakan login.', data: admin });
  } catch (err) {
    audit.recordEnd(auditId, { success: false, message: err.message, durationMs: Date.now() - startedAt });
    res.status(err.code === 'SETUP_ALREADY_COMPLETED' ? 409 : 400).json({ success: false, message: err.message, code: err.code || 'SETUP_FAILED' });
  }
});

router.post('/login', loginLimiter, (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ success: false, message: 'Origin request tidak valid.', code: 'INVALID_ORIGIN' });
  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: 'auth.login', ip: req.ip, params: { username: req.body?.username } });
  const session = authStore.createSession({ username: req.body?.username, password: req.body?.password, ip: req.ip, userAgent: req.get('user-agent') });
  if (!session) {
    audit.recordEnd(auditId, { success: false, message: 'Kredensial tidak valid.', durationMs: Date.now() - startedAt });
    return res.status(401).json({ success: false, message: 'Username atau password salah.', code: 'INVALID_CREDENTIALS' });
  }
  res.set('Set-Cookie', authStore.sessionCookies(session.token, session.csrfToken));
  res.set('Cache-Control', 'no-store');
  audit.recordEnd(auditId, { success: true, message: 'Login berhasil.', durationMs: Date.now() - startedAt });
  res.json({ success: true, message: 'Login berhasil.', data: { username: session.username, csrfToken: session.csrfToken, expiresAt: session.expiresAt } });
});

router.get('/session', (req, res) => {
  const verified = authStore.verifySession(authStore.getSessionToken(req));
  res.set('Cache-Control', 'no-store');
  if (!verified) return res.status(401).json({ success: false, message: 'Session tidak valid atau sudah berakhir.', code: 'UNAUTHORIZED' });
  res.json({ success: true, message: 'OK', data: { username: verified.username, expiresAt: verified.session.expiresAt } });
});

router.get('/api-keys', (req, res) => {
  if (!requireSession(req, res)) return;
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, message: 'OK', data: { keys: config.listApiKeys() } });
});
router.post('/api-keys', sensitiveActionLimiter, (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ success: false, message: 'Origin request tidak valid.', code: 'INVALID_ORIGIN' });
  const session = requireSession(req, res, true);
  if (!session) return;
  if (!authStore.verifyAdminPassword(req.body?.password)) return res.status(403).json({ success: false, message: 'Password admin salah.', code: 'INVALID_CREDENTIALS' });
  try {
    const created = config.createNamedApiKey(req.body?.name);
    const auditId = audit.recordStart({ action: 'auth.api-key.create', ip: req.ip, params: { username: session.username, id: created.id, name: created.name } });
    audit.recordEnd(auditId, { success: true, message: 'API key dibuat.', durationMs: 0 });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, message: 'API key berhasil dibuat.', data: created });
  } catch (err) {
    res.status(err.code === 'API_KEY_NAME_EXISTS' ? 409 : 400).json({ success: false, message: err.message, code: err.code || 'API_KEY_CREATE_FAILED' });
  }
});
router.post('/api-keys/:id/reveal', sensitiveActionLimiter, (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ success: false, message: 'Origin request tidak valid.', code: 'INVALID_ORIGIN' });
  const session = requireSession(req, res, true);
  if (!session) return;
  if (!authStore.verifyAdminPassword(req.body?.password)) return res.status(403).json({ success: false, message: 'Password admin salah.', code: 'INVALID_CREDENTIALS' });
  try {
    const revealed = config.revealApiKey(req.params.id);
    const auditId = audit.recordStart({ action: 'auth.api-key.reveal', ip: req.ip, params: { username: session.username, id: revealed.id, name: revealed.name } });
    audit.recordEnd(auditId, { success: true, message: 'API key direveal.', durationMs: 0 });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, message: 'API key ditampilkan.', data: revealed });
  } catch (err) {
    res.status(err.code === 'API_KEY_NOT_FOUND' ? 404 : 400).json({ success: false, message: err.message, code: err.code || 'API_KEY_REVEAL_FAILED' });
  }
});
router.delete('/api-keys/:id', sensitiveActionLimiter, (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ success: false, message: 'Origin request tidak valid.', code: 'INVALID_ORIGIN' });
  const session = requireSession(req, res, true);
  if (!session) return;
  if (req.body?.confirm !== true) return res.status(400).json({ success: false, message: 'Konfirmasi revoke wajib.', code: 'CONFIRM_REQUIRED' });
  if (!authStore.verifyAdminPassword(req.body?.password)) return res.status(403).json({ success: false, message: 'Password admin salah.', code: 'INVALID_CREDENTIALS' });
  const removed = config.revokeApiKey(req.params.id);
  if (!removed) return res.status(404).json({ success: false, message: 'API key tidak ditemukan.', code: 'API_KEY_NOT_FOUND' });
  const auditId = audit.recordStart({ action: 'auth.api-key.revoke', ip: req.ip, params: { username: session.username, id: req.params.id } });
  audit.recordEnd(auditId, { success: true, message: 'API key dicabut.', durationMs: 0 });
  res.json({ success: true, message: 'API key dicabut.' });
});

router.get('/api-key/status', (req, res) => {
  if (!requireSession(req, res)) return;
  const c = config.loadConfig().api || {};
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, message: 'OK', data: { configured: Boolean(c.key_hash && c.key_salt) } });
});
router.post('/api-key', sensitiveActionLimiter, (req, res) => {
  if (!sameOrigin(req)) return res.status(403).json({ success: false, message: 'Origin request tidak valid.', code: 'INVALID_ORIGIN' });
  const session = requireSession(req, res, true);
  if (!session) return;
  if (!authStore.verifyAdminPassword(req.body?.password)) return res.status(403).json({ success: false, message: 'Password admin salah.', code: 'INVALID_CREDENTIALS' });
  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: 'auth.api-key.rotate', ip: req.ip, params: { username: session.username } });
  try {
    const apiKey = config.generateApiKey();
    audit.recordEnd(auditId, { success: true, message: 'API key dibuat.', durationMs: Date.now() - startedAt });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, message: 'API key berhasil dibuat.', data: { apiKey } });
  } catch (err) {
    audit.recordEnd(auditId, { success: false, message: err.message, durationMs: Date.now() - startedAt });
    res.status(500).json({ success: false, message: 'Gagal membuat API key.', code: 'API_KEY_CREATE_FAILED' });
  }
});
router.post('/logout', (req, res) => {
  authStore.revokeSession(authStore.getSessionToken(req));
  res.set('Set-Cookie', authStore.clearSessionCookies());
  res.json({ success: true, message: 'Logout berhasil.' });
});

module.exports = router;
