const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJSON, withFileLock } = require('../utils/safeFile');

const AUTH_PATH = process.env.VPS_MANAGER_AUTH_PATH || path.join(__dirname, '..', '..', 'data', 'auth.json');
const LOCK_PATH = process.env.VPS_MANAGER_AUTH_LOCK_PATH
  || path.join(path.dirname(AUTH_PATH), '.auth.lock');
const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'vps_session';
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function emptyStore() {
  return { version: 1, admin: null, setup: null, sessions: [] };
}

function ensureStore() {
  const dir = path.dirname(AUTH_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(AUTH_PATH)) atomicWriteJSON(AUTH_PATH, emptyStore(), 0o600);
  try { fs.chmodSync(AUTH_PATH, 0o600); } catch { /* best effort */ }
}

function loadStore() {
  ensureStore();
  const parsed = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
  return { ...emptyStore(), ...parsed, sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
}

function saveStore(store) {
  ensureStore();
  atomicWriteJSON(AUTH_PATH, store, 0o600);
}

function digest(value, salt) {
  return crypto.scryptSync(value, salt, 64).toString('hex');
}

function safeEqualHex(left, right) {
  if (!left || !right) return false;
  let a;
  let b;
  try { a = Buffer.from(left, 'hex'); b = Buffer.from(right, 'hex'); } catch { return false; }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashValue(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_RE.test(value)) throw new Error('Username harus 3-32 karakter dan hanya boleh berisi huruf, angka, titik, dash, atau underscore.');
  return value;
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 12) throw new Error('Password minimal 12 karakter.');
  if (value.length > 256) throw new Error('Password maksimal 256 karakter.');
  return value;
}

function status() {
  const store = loadStore();
  return {
    initialized: !!store.admin,
    setupEnabled: !store.admin && !!store.setup,
    setupExpired: !store.admin && !!store.setup && Date.parse(store.setup.expiresAt) <= Date.now(),
    setupExpiresAt: !store.admin && store.setup ? store.setup.expiresAt : null,
  };
}

function generateSetupToken({ ttlMs = SETUP_TTL_MS } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  return withFileLock(LOCK_PATH, () => {
    const store = loadStore();
    if (store.admin) throw new Error('Administrator sudah tersedia. Setup token tidak bisa dibuat lagi.');
    const salt = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    store.setup = {
      tokenSalt: salt,
      tokenHash: digest(token, salt),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    saveStore(store);
    return { token, expiresAt: store.setup.expiresAt };
  });
}

function verifySetupToken(store, token) {
  if (!store.setup || !token) return { ok: false, code: 'SETUP_TOKEN_INVALID' };
  if (Date.parse(store.setup.expiresAt) <= Date.now()) return { ok: false, code: 'SETUP_TOKEN_EXPIRED' };
  const candidate = digest(String(token), store.setup.tokenSalt);
  return safeEqualHex(candidate, store.setup.tokenHash) ? { ok: true } : { ok: false, code: 'SETUP_TOKEN_INVALID' };
}

function createAdmin({ token, username, password }) {
  const cleanUsername = validateUsername(username);
  const cleanPassword = validatePassword(password);
  return withFileLock(LOCK_PATH, () => {
    const store = loadStore();
    if (store.admin) {
      const err = new Error('Administrator sudah dibuat. Silakan masuk melalui halaman login.');
      err.code = 'SETUP_ALREADY_COMPLETED';
      throw err;
    }
    const tokenResult = verifySetupToken(store, token);
    if (!tokenResult.ok) {
      const err = new Error(tokenResult.code === 'SETUP_TOKEN_EXPIRED'
        ? 'Setup token sudah kedaluwarsa. Buat token baru lewat SSH.'
        : 'Setup token tidak valid.');
      err.code = tokenResult.code;
      throw err;
    }
    const passwordSalt = crypto.randomBytes(16).toString('hex');
    store.admin = {
      username: cleanUsername,
      passwordSalt,
      passwordHash: digest(cleanPassword, passwordSalt),
      createdAt: new Date().toISOString(),
    };
    store.setup = null;
    store.sessions = [];
    saveStore(store);
    return { username: cleanUsername };
  }, { timeoutMs: 15000, staleMs: 60000 });
}

function createSession({ username, password, ip, userAgent }) {
  return withFileLock(LOCK_PATH, () => {
    const store = loadStore();
    if (!store.admin) return null;
    const candidateHash = digest(String(password || ''), store.admin.passwordSalt);
    if (String(username || '').trim() !== store.admin.username || !safeEqualHex(candidateHash, store.admin.passwordHash)) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    store.sessions = (store.sessions || []).filter((session) => Date.parse(session.expiresAt) > now).slice(-19);
    store.sessions.push({
      tokenHash: hashValue(token),
      csrfHash: hashValue(csrfToken),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      ip: ip || null,
      userAgent: String(userAgent || '').slice(0, 300),
    });
    saveStore(store);
    return { token, csrfToken, username: store.admin.username, expiresAt: new Date(now + SESSION_TTL_MS).toISOString() };
  }, { timeoutMs: 15000, staleMs: 60000 });
}

function verifySession(token, csrfToken = null) {
  if (!token) return null;
  const store = loadStore();
  if (!store.admin) return null;
  const session = (store.sessions || []).find((item) => item.tokenHash === hashValue(String(token)));
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
  if (csrfToken && !safeEqualHex(hashValue(String(csrfToken)), session.csrfHash)) return null;
  return { username: store.admin.username, session };
}

function revokeSession(token) {
  if (!token) return;
  withFileLock(LOCK_PATH, () => {
    const store = loadStore();
    const tokenHash = hashValue(String(token));
    store.sessions = (store.sessions || []).filter((item) => item.tokenHash !== tokenHash);
    saveStore(store);
  });
}

function resetPassword(password) {
  const cleanPassword = validatePassword(password);
  return withFileLock(LOCK_PATH, () => {
    const store = loadStore();
    if (!store.admin) throw new Error('Administrator belum dibuat.');
    const salt = crypto.randomBytes(16).toString('hex');
    store.admin.passwordSalt = salt;
    store.admin.passwordHash = digest(cleanPassword, salt);
    store.admin.passwordChangedAt = new Date().toISOString();
    store.sessions = [];
    saveStore(store);
    return { username: store.admin.username };
  }, { timeoutMs: 15000, staleMs: 60000 });
}

function parseCookies(header = '') {
  return String(header).split(';').reduce((out, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return out;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(value); }
      catch { out[key] = value; }
    }
    return out;
  }, {});
}

function getSessionToken(req) {
  return parseCookies(req.headers?.cookie || '')[COOKIE_NAME] || null;
}

function sessionCookies(token, csrfToken) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
    `vps_csrf=${encodeURIComponent(csrfToken)}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAge}`,
  ];
}

function clearSessionCookies() {
  return [
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
    'vps_csrf=; Path=/; Secure; SameSite=Strict; Max-Age=0',
  ];
}

module.exports = {
  AUTH_PATH,
  status,
  generateSetupToken,
  createAdmin,
  createSession,
  verifySession,
  revokeSession,
  resetPassword,
  getSessionToken,
  sessionCookies,
  clearSessionCookies,
};
