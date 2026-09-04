const express = require('express');
const rateLimit = require('express-rate-limit');
const authStore = require('../../auth/authStore');
const audit = require('../audit');

const router = express.Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Terlalu banyak percobaan. Coba lagi dalam 15 menit.', code: 'TOO_MANY_ATTEMPTS' },
});

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}

router.get('/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ success: true, message: 'OK', data: authStore.status() });
});

router.post('/setup', authLimiter, (req, res) => {
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

router.post('/login', authLimiter, (req, res) => {
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

router.post('/logout', (req, res) => {
  authStore.revokeSession(authStore.getSessionToken(req));
  res.set('Set-Cookie', authStore.clearSessionCookies());
  res.json({ success: true, message: 'Logout berhasil.' });
});

module.exports = router;
