const express = require('express');
const cleanup = require('../../cleanup/cleanup');
const pm2 = require('../../pm2/pm2');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();

// Username OS - whitelist ketat (defense-in-depth; cleanup.getUserHome()
// sendiri sudah aman dari injection lewat execFileSync, tapi tetap divalidasi
// di level route biar error message-nya jelas buat input yang jelas ngaco).
const USERNAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * Scan cache/file regenerable di folder home sebuah user OS (Next.js build
 * cache, npm/yarn/pnpm/pip cache, PM2 log). Read-only - CUMA scan, gak ada
 * yang dihapus lewat endpoint ini (lihat Security note di bawah).
 */
router.get('/scan/user/:username', (req, res) => {
  const ACTION = 'cleanup.scanUserCache';
  if (!guard(ACTION, res)) return;

  const { username } = req.params;
  if (!username || !USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      success: false,
      message: 'username wajib diisi, hanya huruf/angka/underscore/dash/titik.',
      code: 'INVALID_INPUT',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { username } });
  const result = cleanup.scanUserCache(username);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'SCAN_USER_CACHE_FAILED' });
  }
  const totalBytes = result.items.reduce((sum, item) => sum + item.bytes, 0);
  res.json({ success: true, message: 'OK', data: { items: result.items, totalBytes, totalBytesLabel: cleanup.formatBytes(totalBytes) } });
});

/**
 * Scan cache di semua folder project yang tercatat di PM2 (path diambil dari
 * cwd PM2 masing-masing app, bukan diketik manual). Read-only.
 */
router.get('/scan/projects', (req, res) => {
  const ACTION = 'cleanup.scanProjectCaches';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });

  const pmResult = pm2.listApps();
  if (!pmResult.ok && (!pmResult.apps || pmResult.apps.length === 0)) {
    audit.recordEnd(auditId, { success: false, message: pmResult.error || 'Gagal ambil daftar PM2.', durationMs: Date.now() - startedAt });
    return res.status(400).json({ success: false, message: pmResult.error || 'Gagal ambil daftar PM2.', code: 'SCAN_PROJECT_CACHES_FAILED' });
  }

  const items = cleanup.scanProjectCaches(pmResult.apps);
  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });

  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  res.json({ success: true, message: 'OK', data: { items, totalBytes, totalBytesLabel: cleanup.formatBytes(totalBytes) } });
});

/**
 * Hapus satu item cache (folder/file) di home sebuah user OS - dipakai buat
 * bersihin item hasil scan/user/:username satu-satu. `targetPath` WAJIB path
 * absolut di dalam home user itu sendiri (dicek lagi di cleanup.deletePath()
 * via getUserHome() + isBlacklisted(), bukan cuma dipercaya dari body).
 * DESTRUKTIF (`rm -rf`, gak ada undo) - WAJIB confirm:true.
 */
router.post('/delete', (req, res) => {
  const ACTION = 'cleanup.deletePath';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { username, targetPath, confirm } = req.body || {};
  if (!username || !USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      success: false,
      message: 'username wajib diisi, hanya huruf/angka/underscore/dash/titik.',
      code: 'INVALID_INPUT',
    });
  }
  if (!targetPath || typeof targetPath !== 'string') {
    return res.status(400).json({ success: false, message: 'targetPath wajib diisi.', code: 'INVALID_INPUT' });
  }

  // FIXED: item cache punya 2 sumber scan dengan arti "boundary folder" beda:
  // - scan/user/:username -> boundary = home OS user (cleanup.getUserHome)
  // - scan/projects        -> boundary = cwd project PM2 (BUKAN home OS user!)
  // Sebelumnya endpoint ini SELALU pakai getUserHome(username) sebagai boundary,
  // jadi item hasil scan/projects (mis. "/opt/apps/zenhub/.next/cache") selalu
  // ditolak cleanup.deletePath() dengan "Path di luar batas folder yang diizinkan"
  // karena home OS user (mis. "/home/www") gak pernah jadi prefix dari cwd project.
  // Sekarang: cek dulu apakah targetPath ada di dalam cwd salah satu app PM2 - kalau
  // ketemu, itu prioritas (dan owner-nya dipakai dari data PM2 sendiri, bukan dari
  // body request, biar rm -rf tetap jalan sebagai user yang benar-benar punya project
  // itu). Kalau bukan project-cache, baru fallback ke behaviour lama (home OS user).
  const pmResult = pm2.listApps();
  const apps = (pmResult && pmResult.apps) || [];
  const matchedApp = apps.find((app) => app.cwd && app.cwd !== '-' && targetPath.startsWith(`${app.cwd}/`));

  let home;
  let effectiveOwner = username;
  if (matchedApp) {
    home = matchedApp.cwd;
    effectiveOwner = matchedApp.owner;
  } else {
    home = cleanup.getUserHome(username);
    if (!home) {
      return res.status(400).json({ success: false, message: `User "${username}" tidak ditemukan.`, code: 'USER_HOME_NOT_FOUND' });
    }
  }

  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Path "${targetPath}" akan dihapus PERMANEN (rm -rf, tidak ada undo). Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { username, targetPath } });
  const result = cleanup.deletePath(effectiveOwner, targetPath, home);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'CLEANUP_DELETE_FAILED' });
  }
  res.json({ success: true, message: `"${targetPath}" berhasil dihapus.` });
});

module.exports = router;

/**
 * Security note: Fase 5 awalnya SENGAJA cuma expose endpoint scan (read-only).
 * `POST /delete` di atas (ditambah belakangan) mengekspos
 * `cleanup.deletePath()` yang sudah di-hardening duluan (execFileSync argv,
 * bukan lagi shell string interpolation), dilindungi `confirmRequired: true`
 * di commandPolicy (sama pola dengan `backup.delete`/`database.drop`) karena
 * `rm -rf` gak ada undo, plus validasi `getUserHome()`/`isBlacklisted()` di
 * dalam cleanup.js sendiri buat cegah path di luar home user ke-hapus.
 */
