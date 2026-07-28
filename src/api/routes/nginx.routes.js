const express = require('express');
const nginx = require('../../nginx/nginx');
const safety = require('../../safety/safety');
const logviewer = require('../../logviewer/logviewer');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const { validateDomainRequired } = require('../../menu/helpers');

const router = express.Router();

// Nama file .conf - whitelist ketat + WAJIB cocok salah satu hasil
// nginx.listSites() (bukan cuma lolos regex), sama prinsipnya kayak
// FILENAME_REGEX di backup.routes.js - filename ini dipakai buat path.join()
// ke confDir() lalu ke command sudo cat/rm, jadi harus dipastikan BENERAN
// site yang valid & ada, bukan sekedar string yang lolos pola.
const FILENAME_REGEX = /^[a-zA-Z0-9._-]+$/;

function isValidFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (!FILENAME_REGEX.test(filename)) return false;
  if (filename.includes('..')) return false;
  if (filename.startsWith('-') || filename.startsWith('.')) return false;
  return true;
}

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * Resolusi & validasi nama file site dari listing riil di disk - SATU-
 * SATUNYA sumber filename yang dipercaya (bukan langsung dari req.params).
 */
function resolveSiteFile(rawFile, res) {
  if (!isValidFilename(rawFile)) {
    res.status(400).json({
      success: false,
      message: 'Nama file tidak valid, hanya huruf/angka/underscore/dash/titik, tidak boleh diawali "-"/"." atau mengandung "..".',
      code: 'INVALID_INPUT',
    });
    return null;
  }
  const sitesResult = nginx.listSites();
  if (!sitesResult.ok) {
    res.status(400).json({ success: false, message: sitesResult.error || 'Gagal membaca folder config nginx.', code: 'NGINX_LIST_FAILED' });
    return null;
  }
  const match = sitesResult.sites.find((s) => s.file === rawFile);
  if (!match) {
    res.status(404).json({ success: false, message: `Site "${rawFile}" tidak ditemukan.`, code: 'SITE_NOT_FOUND' });
    return null;
  }
  return match;
}

router.get('/sites', (req, res) => {
  const ACTION = 'nginx.listSites';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = nginx.listSites();
  audit.recordEnd(auditId, { success: result.ok, message: result.error || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.error, code: 'NGINX_LIST_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { sites: result.sites } });
});

router.get('/sites/:file', (req, res) => {
  const ACTION = 'nginx.viewSite';
  if (!guard(ACTION, res)) return;
  const site = resolveSiteFile(req.params.file, res);
  if (!site) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { file: site.file } });
  const result = nginx.viewSite(site.file);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'NGINX_VIEW_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { file: site.file, domain: site.domain, target: site.target, content: result.output } });
});

/**
 * Error log nginx per-domain (baca file {nginx_log_dir}/{domain}.error.log,
 * konvensi aaPanel - lihat logviewer.getNginxErrorLog). Read-only. `lines`
 * lewat query string, dibatasi 1-1000 sama pola dengan pm2.routes.js.
 * Domain diambil dari hasil resolveSiteFile() (bukan langsung dari client)
 * lalu di-split ` ` (site.domain bisa berisi lebih dari 1 domain per site,
 * misal "example.com www.example.com" - log file cuma per domain utama).
 */
router.get('/sites/:file/error-log', (req, res) => {
  const ACTION = 'nginx.errorLog';
  if (!guard(ACTION, res)) return;
  const site = resolveSiteFile(req.params.file, res);
  if (!site) return;

  let lines = parseInt(req.query.lines, 10);
  if (!Number.isFinite(lines) || lines <= 0) lines = 60;
  lines = Math.min(lines, 1000);

  const domain = site.domain.split(' ')[0];

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { file: site.file, domain, lines } });
  const result = logviewer.getNginxErrorLog(domain, lines);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'NGINX_LOG_FAILED' });
  }

  const classified = result.lines.map((line) => ({ line, level: logviewer.classifyLine(line) }));
  res.json({ success: true, message: 'OK', data: { file: site.file, domain, lines: classified } });
});

router.get('/test-config', (req, res) => {
  const ACTION = 'nginx.testConfig';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = nginx.testConfig();
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  res.json({ success: true, message: 'OK', data: { valid: result.ok, output: result.errorMessage || result.output || '' } });
});

/**
 * Bikin reverse-proxy site baru. Add-only, konflik domain sudah dicek lewat
 * safety.checkDomain() di bawah - gak perlu confirm (lihat commandPolicy.js).
 */
router.post('/sites', (req, res) => {
  const ACTION = 'nginx.createSite';
  if (!guard(ACTION, res)) return;

  const { domain, port } = req.body || {};
  const domainCheck = validateDomainRequired(domain);
  if (domainCheck !== true) {
    return res.status(400).json({ success: false, message: domainCheck, code: 'INVALID_INPUT' });
  }
  const portNum = parseInt(port, 10);
  if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
    return res.status(400).json({ success: false, message: 'port wajib diisi, angka 1-65535.', code: 'INVALID_INPUT' });
  }

  const domainCheckResult = safety.checkDomain(domain);
  if (!domainCheckResult.pass) {
    return res.status(409).json({ success: false, message: domainCheckResult.message, code: 'DOMAIN_CONFLICT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { domain, port: portNum } });
  const result = nginx.createReverseProxySite({ domain, port: portNum });
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'NGINX_CREATE_FAILED' });
  }
  res.json({ success: true, message: `Site "${domain}" berhasil dibuat dan nginx sudah di-reload.` });
});

router.post('/reload', (req, res) => {
  const ACTION = 'nginx.reload';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = nginx.reload();
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'NGINX_RELOAD_FAILED' });
  }
  res.json({ success: true, message: 'Nginx berhasil di-reload.' });
});

/**
 * Hapus site. Domain langsung unreachable - WAJIB confirm:true.
 */
router.delete('/sites/:file', (req, res) => {
  const ACTION = 'nginx.deleteSite';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const site = resolveSiteFile(req.params.file, res);
  if (!site) return;

  const { confirm } = req.body || {};
  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Site "${site.file}" (domain "${site.domain}") akan dihapus dan domain langsung unreachable. Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { file: site.file } });
  const result = nginx.deleteSite(site.file);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'NGINX_DELETE_FAILED' });
  }
  res.json({ success: true, message: `Site "${site.file}" dihapus dan nginx sudah di-reload.` });
});

module.exports = router;
