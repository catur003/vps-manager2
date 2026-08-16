const express = require('express');
const jobStore = require('../jobs/jobStore');
const commandPolicy = require('../commandPolicy');

const router = express.Router();

router.get('/:id', (req, res) => {
  if (!commandPolicy.isExposed('jobs.get')) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const job = jobStore.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ success: false, message: 'Job tidak ditemukan.', code: 'JOB_NOT_FOUND' });
  }
  res.json({ success: true, message: 'OK', data: jobStore.toPublicJob(job) });
});

router.get('/', (req, res) => {
  if (!commandPolicy.isExposed('jobs.list')) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  res.json({ success: true, message: 'OK', data: jobStore.listJobs().map(jobStore.toPublicJob) });
});

/**
 * DELETE /jobs - bersihkan SEMUA job yang statusnya final (success/failed/
 * interrupted) sekaligus. Job yang masih pending/running gak kesentuh.
 * Diletakkan SEBELUM route "/:id" biar path "/" gak ketangkep sebagai
 * param :id (express match top-down, urutan ini sengaja).
 */
router.delete('/', (req, res) => {
  if (!commandPolicy.isExposed('jobs.clear')) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({
      success: false,
      message: 'Aksi ini butuh konfirmasi eksplisit. Kirim { "confirm": true } di body.',
      code: 'CONFIRMATION_REQUIRED',
    });
  }
  const count = jobStore.clearFinishedJobs();
  res.json({ success: true, message: `${count} job selesai dibersihkan.`, data: { count } });
});

/**
 * DELETE /jobs/:id - hapus satu job dari histori. Ditolak kalau job masih
 * pending/running (lihat jobStore.deleteJob) - job yang lagi jalan gak boleh
 * "dihilangin" dari histori, harus nunggu selesai/gagal dulu.
 */
router.delete('/:id', (req, res) => {
  if (!commandPolicy.isExposed('jobs.delete')) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const result = jobStore.deleteJob(req.params.id);
  if (!result.ok && result.reason === 'NOT_FOUND') {
    return res.status(404).json({ success: false, message: 'Job tidak ditemukan.', code: 'JOB_NOT_FOUND' });
  }
  if (!result.ok && result.reason === 'STILL_RUNNING') {
    return res.status(400).json({ success: false, message: 'Job masih berjalan, gak bisa dihapus - tunggu selesai/gagal dulu.', code: 'JOB_STILL_RUNNING' });
  }
  res.json({ success: true, message: 'Job dihapus.' });
});

module.exports = router;
