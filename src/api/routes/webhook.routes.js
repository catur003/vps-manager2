const express = require('express');
const crypto = require('crypto');
const config = require('../../config/config');
const registry = require('../../registry/registry');
const git = require('../../git/git');
const redeploy = require('../../deploy/redeploy');
const jobStore = require('../jobs/jobStore');

const router = express.Router();

/**
 * Verifikasi signature GitHub (`X-Hub-Signature-256: sha256=<hmac>`) pakai
 * `webhook_secret` di Configuration - TANPA ini siapapun yang tau URL bisa
 * trigger redeploy paksa (bukan cuma "annoying", tapi bisa dipakai buat DoS
 * lewat rebuild berulang, atau nge-trigger redeploy pas kode remote lagi
 * dalam kondisi rusak). Endpoint ini SENGAJA di luar apiKeyAuth (GitHub gak
 * bisa kirim Bearer token kita), jadi signature INI yang jadi satu-satunya
 * lapis auth - wajib dicek dengan timing-safe compare.
 */
function verifySignature(req) {
  const cfg = config.loadConfig();
  if (!cfg.webhook_secret) return { ok: false, reason: 'webhook_secret belum diset di Configuration.' };

  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return { ok: false, reason: 'Header X-Hub-Signature-256 tidak ada.' };

  const expected = 'sha256=' + crypto.createHmac('sha256', cfg.webhook_secret).update(req.rawBody || '').digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'Signature tidak cocok.' };
  }
  return { ok: true };
}

/**
 * POST /webhooks/github/:projectName - dipanggil GitHub tiap ada push.
 * Alurnya SENGAJA sinkron langsung di request handler (bukan job/fork kayak
 * POST /deploy) - project SUDAH ada (bukan setup awal), jadi cuma pull+
 * install+build+restart, biasanya jauh lebih cepat daripada clone dari nol.
 * Tetap dicatat ke jobStore biar keliatan histori/progress-nya di dashboard
 * yang sama dengan deploy biasa.
 */
router.post('/github/:projectName', async (req, res) => {
  const verification = verifySignature(req);
  if (!verification.ok) {
    return res.status(401).json({ success: false, message: verification.reason, code: 'INVALID_SIGNATURE' });
  }

  const project = registry.findProject(req.params.projectName);
  if (!project) {
    return res.status(404).json({ success: false, message: `Project "${req.params.projectName}" tidak ditemukan di registry.`, code: 'PROJECT_NOT_FOUND' });
  }

  // Balas GitHub SEGERA (GitHub kasih timeout ~10 detik ke webhook, sedangkan
  // pull+install+build bisa jauh lebih lama) - proses lanjut di background,
  // progress dipantau lewat jobStore/dashboard, bukan lewat response ini.
  const jobId = jobStore.createJob('webhook_redeploy', { name: project.name });
  res.status(202).json({ success: true, message: 'Redeploy diterima, jalan di background.', data: { jobId } });

  await redeploy.runRedeploy(project, jobId, { triggeredBy: 'webhook GitHub' });
});

module.exports = router;
