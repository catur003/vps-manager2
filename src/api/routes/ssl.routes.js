const path = require('path');
const { fork } = require('child_process');
const express = require('express');
const jobStore = require('../jobs/jobStore');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const registry = require('../../registry/registry');
const ssl = require('../../ssl/ssl');
const config = require('../../config/config');
const { validateDomainRequired } = require('../../menu/helpers');

const router = express.Router();
const ACTION = 'ssl.issue';
const WORKER_PATH = path.join(__dirname, '..', 'jobs', 'sslWorker.js');

/**
 * Setup Cloudflare API token - PRASYARAT sebelum bisa minta wildcard di
 * POST /issue (yang nolak sendiri kalau belum di-setup, lihat ssl.js).
 * Endpoint TERPISAH dari POST /issue (bukan cuma parameter tambahan)
 * karena ini nyimpen SECRET (token), butuh alur & audit sendiri, dan cuma
 * perlu dijalanin SEKALI per server (bukan tiap kali terbitin cert).
 */
router.post('/cloudflare-setup', (req, res) => {
  const CF_ACTION = 'ssl.cloudflareSetup';
  if (!commandPolicy.isExposed(CF_ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const { apiToken } = req.body || {};
  if (!apiToken || typeof apiToken !== 'string' || apiToken.trim().length < 10) {
    return res.status(400).json({ success: false, message: 'API token Cloudflare wajib diisi (token, bukan Global API Key).', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  // params SENGAJA gak nyimpen token mentah ke audit log - cuma nyimpen
  // "dipanggil", bukan isinya.
  const auditId = audit.recordStart({ action: CF_ACTION, ip: req.ip, params: {} });
  const result = ssl.setupCloudflareCredentials(apiToken.trim());
  audit.recordEnd(auditId, { success: result.ok, message: result.ok ? 'OK' : result.errorMessage, durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(500).json({ success: false, message: result.errorMessage, code: 'CLOUDFLARE_SETUP_FAILED' });
  }
  res.json({ success: true, message: 'Cloudflare API token tersimpan. Sekarang bisa minta wildcard cert (*.domain) lewat POST /ssl/issue dengan { "wildcard": true }.' });
});

/** GET /ssl/cloudflare-status - dipakai app buat nampilin toggle "Wildcard" atau enggak (disable kalau belum di-setup). */
router.get('/cloudflare-status', (req, res) => {
  if (!commandPolicy.isExposed('ssl.issue')) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const configured = Boolean(config.loadConfig().cloudflare_credentials_path);
  res.json({ success: true, message: 'OK', data: { configured } });
});

router.post('/issue', (req, res) => {
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { domain, wildcard } = req.body || {};
  // Validasi format DULU (defense-in-depth) - sebelumnya cuma dijaga tidak
  // langsung lewat gate findByDomain() di bawah (yang secara TIDAK LANGSUNG
  // aman karena domain di registry sudah lolos validateDomainRequired() pas
  // deploy). Divalidasi eksplisit juga di sini biar gak bergantung diam-diam
  // ke asumsi itu, dan biar pesan error lebih jelas kalau formatnya salah.
  const domainCheck = validateDomainRequired(domain);
  if (domainCheck !== true) {
    return res.status(400).json({ success: false, message: domainCheck, code: 'INVALID_INPUT' });
  }

  // Domain WAJIB sudah terdaftar di registry (sebagai domain utama ATAU
  // alias-nya - lihat registry.findByDomain) - ini bukan endpoint "issue
  // cert buat domain sembarang". Alasan: (1) certbot butuh port project buat
  // nginx.upgradeToSSL() sesudahnya, (2) mencegah API ini disalahgunakan
  // buat spam request ke Let's Encrypt atas nama domain yang gak ada
  // hubungannya sama VPS ini (bisa kena rate limit certbot dari domain yang
  // bukan tanggung jawab kita).
  const project = registry.findByDomain(domain);
  if (!project) {
    return res.status(404).json({
      success: false,
      message: `Domain "${domain}" belum terdaftar di registry (belum ada project yang deploy ke domain ini, dan bukan alias dari project manapun - tambahkan dulu lewat POST /domains/:domain/aliases kalau ini domain "www" dari project yang sudah ada).`,
      code: 'DOMAIN_NOT_REGISTERED',
    });
  }

  // Selalu issue buat domain UTAMA project + SEMUA alias-nya sekaligus
  // (satu sertifikat SAN) - bukan cuma domain persis yang diketik user.
  // Ini yang bikin issue SSL dari "zenin.my.id" ATAU "www.zenin.my.id"
  // hasilnya sama: satu sertifikat yang cover keduanya.
  //
  // Kalau `wildcard: true`: validasi Cloudflare-nya udah di-setup DI SINI
  // juga (bukan cuma di worker) - biar gagalnya cepat & jelas SEBELUM job
  // dibuat, bukan nunggu worker jalan dulu baru ketauan gagal.
  if (wildcard && !config.loadConfig().cloudflare_credentials_path) {
    return res.status(400).json({
      success: false,
      message: 'Wildcard butuh Cloudflare API token dulu - setup lewat POST /ssl/cloudflare-setup sebelum coba lagi.',
      code: 'CLOUDFLARE_NOT_CONFIGURED',
    });
  }

  const primaryDomain = project.domain;
  const aliases = project.aliases || [];

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { domain: primaryDomain, aliases, wildcard: Boolean(wildcard) } });
  const jobId = jobStore.createJob('ssl_issue', { domain: primaryDomain, aliases, port: project.port, wildcard: Boolean(wildcard) });

  const child = fork(WORKER_PATH, [jobId], { detached: true, stdio: 'ignore' });
  child.unref();

  audit.recordEnd(auditId, { success: true, message: `Job ${jobId} dibuat, issue SSL jalan di background.`, durationMs: Date.now() - startedAt });

  res.status(202).json({
    success: true,
    message: 'Penerbitan SSL dimulai di background. Cek progress lewat GET /jobs/:id.',
    data: { jobId },
  });
});

module.exports = router;
