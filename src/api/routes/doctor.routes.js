const express = require('express');
const doctor = require('../../doctor/doctor');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();

// Read-only - gak ada action destruktif di file ini.
function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * GET /doctor/permissions - self-check kesiapan sistem: sudoers NOPASSWD
 * buat deploy_user, kecocokan owner folder deploy, dan ketersediaan command
 * eksternal (git/nginx/certbot). Dipanggil otomatis oleh app pas tab
 * Diagnostik dibuka - biar masalah ketauan dari awal, bukan pas user lagi
 * coba hapus cache/deploy dan gagal tanpa konteks jelas.
 */
router.get('/permissions', (req, res) => {
  const ACTION = 'doctor.checkPermissions';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = doctor.checkPermissions();
  audit.recordEnd(auditId, { success: true, message: result.ok ? 'OK' : `${result.issues.length} isu ditemukan`, durationMs: Date.now() - startedAt });

  res.json({ success: true, message: result.ok ? 'Semua siap.' : 'Ada isu yang perlu dibenerin.', data: result });
});

module.exports = router;
