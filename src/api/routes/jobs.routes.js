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

module.exports = router;
