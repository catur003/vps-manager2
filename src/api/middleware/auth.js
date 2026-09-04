const config = require('../../config/config');
const authStore = require('../../auth/authStore');

/**
 * Lockout per-IP buat percobaan API key yang GAGAL. Alasannya BUKAN buat
 * nyegah brute-force nebak key (key-nya 256-bit random, brute force gak
 * feasible) - tapi nyegah DoS: `verifyApiKey()` manggil `crypto.scryptSync`
 * yang SENGAJA berat di CPU (~50-100ms/panggilan), jadi tanpa limit,
 * penyerang bisa banjirin request dengan key ngasal dan bikin CPU server
 * abis cuma dari hash comparison-nya doang - gak perlu berhasil auth sama
 * sekali buat DoS server ini.
 *
 * In-memory (bukan file/Redis) - cukup buat 1 instance API, reset kalau
 * proses restart (dampaknya cuma window rate-limit ke-reset, bukan celah
 * keamanan).
 */
const FAILED_ATTEMPT_LIMIT = 10;
const FAILED_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

const failedAttempts = new Map(); // ip -> { count, windowStart, lockedUntil }

function getClientIp(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function isLockedOut(ip) {
  const entry = failedAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    failedAttempts.delete(ip); // lockout selesai, reset bersih
    return false;
  }
  return false;
}

function recordFailure(ip) {
  const now = Date.now();
  let entry = failedAttempts.get(ip);
  if (!entry || now - entry.windowStart > FAILED_ATTEMPT_WINDOW_MS) {
    entry = { count: 0, windowStart: now, lockedUntil: null };
  }
  entry.count += 1;
  if (entry.count >= FAILED_ATTEMPT_LIMIT) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  failedAttempts.set(ip, entry);
}

function recordSuccess(ip) {
  failedAttempts.delete(ip);
}

/**
 * Cek header "Authorization: Bearer <api_key>" cocok sama hash tersimpan
 * (lihat config.generateApiKey/verifyApiKey). Dipasang di server.js buat
 * SEMUA route kecuali /health.
 */
function apiKeyAuth(req, res, next) {
  const ip = getClientIp(req);

  if (isLockedOut(ip)) {
    return res.status(429).json({
      success: false,
      message: 'Terlalu banyak percobaan API key gagal dari IP ini. Coba lagi dalam beberapa menit.',
      code: 'TOO_MANY_ATTEMPTS',
    });
  }

  const header = req.headers.authorization || '';
  // Fallback ke query string (?key=...) KHUSUS buat request yang gak bisa
  // nyetel header custom - `window.open()`/link download langsung dari
  // browser (backup.routes.js download) gak lewat fetch(), jadi gak ada
  // cara nyetel Authorization header. Header tetap cara utama/disarankan
  // (gak nyangkut di browser history/access log kayak query string).
  const token = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : (req.query.key || null);

  if (config.verifyApiKey(token)) {
    recordSuccess(ip);
    req.auth = { type: 'api-key' };
    return next();
  }

  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const csrfToken = unsafe ? req.get('x-csrf-token') : null;
  const session = authStore.verifySession(authStore.getSessionToken(req), csrfToken);
  let validOrigin = true;
  const origin = req.get('origin');
  if (origin) {
    try { validOrigin = new URL(origin).host === req.get('host'); } catch { validOrigin = false; }
  }
  if (session && (!unsafe || (csrfToken && validOrigin))) {
    recordSuccess(ip);
    req.auth = { type: 'session', username: session.username };
    return next();
  }

  recordFailure(ip);
  return res.status(401).json({
    success: false,
    message: authStore.status().initialized ? 'Session atau API key tidak valid.' : 'Administrator belum dibuat. Selesaikan setup terlebih dahulu.',
    code: 'UNAUTHORIZED',
  });
}

function authenticateUpgrade(req, legacyKey = null) {
  if (config.verifyApiKey(legacyKey)) return { type: 'api-key' };
  const session = authStore.verifySession(authStore.getSessionToken(req));
  return session ? { type: 'session', username: session.username } : null;
}


module.exports = { apiKeyAuth, authenticateUpgrade };
