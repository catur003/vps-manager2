const path = require('path');
const { fork } = require('child_process');
const express = require('express');
const jobStore = require('../jobs/jobStore');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const registry = require('../../registry/registry');
const { validateDomainRequired } = require('../../menu/helpers');

const router = express.Router();
const ACTION = 'ssl.issue';
const WORKER_PATH = path.join(__dirname, '..', 'jobs', 'sslWorker.js');

router.post('/issue', (req, res) => {
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { domain } = req.body || {};
  // Validasi format DULU (defense-in-depth) - sebelumnya cuma dijaga tidak
  // langsung lewat gate findByDomain() di bawah (yang secara TIDAK LANGSUNG
  // aman karena domain di registry sudah lolos validateDomainRequired() pas
  // deploy). Divalidasi eksplisit juga di sini biar gak bergantung diam-diam
  // ke asumsi itu, dan biar pesan error lebih jelas kalau formatnya salah.
  const domainCheck = validateDomainRequired(domain);
  if (domainCheck !== true) {
    return res.status(400).json({ success: false, message: domainCheck, code: 'INVALID_INPUT' });
  }

  // Domain WAJIB sudah terdaftar di registry (sudah ada project-nya) -
  // ini bukan endpoint "issue cert buat domain sembarang". Alasan: (1)
  // certbot butuh port project buat nginx.upgradeToSSL() sesudahnya, (2)
  // mencegah API ini disalahgunakan buat spam request ke Let's Encrypt atas
  // nama domain yang gak ada hubungannya sama VPS ini (bisa kena rate limit
  // certbot dari domain yang bukan tanggung jawab kita).
  const project = registry.findByDomain(domain);
  if (!project) {
    return res.status(404).json({
      success: false,
      message: `Domain "${domain}" belum terdaftar di registry (belum ada project yang deploy ke domain ini).`,
      code: 'DOMAIN_NOT_REGISTERED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { domain } });
  const jobId = jobStore.createJob('ssl_issue', { domain, port: project.port });

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
