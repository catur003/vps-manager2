/**
 * Dijalankan via child_process.fork() - pola sama seperti deployWorker.js/
 * buildWorker.js. `prisma db seed` bisa lama kalau seed-nya nge-generate
 * data banyak, jadi tetap job-based walau cuma 1 step.
 */
const jobStore = require('./jobStore');
const build = require('../../build/build');

const jobId = process.argv[2];

function fail(message) {
  jobStore.updateJob(jobId, { status: 'failed', message });
  process.exit(1);
}

if (!jobId) {
  console.error('seedWorker: jobId tidak disertakan.');
  process.exit(1);
}

const job = jobStore.getJob(jobId);
if (!job) {
  console.error(`seedWorker: job ${jobId} tidak ditemukan di jobStore.`);
  process.exit(1);
}

const { projectPath, deployUser } = job.params;

jobStore.updateJob(jobId, { status: 'running', message: 'Menjalankan prisma db seed...' });

try {
  const result = build.prismaSeed(projectPath, deployUser);
  jobStore.appendJobStep(jobId, { step: 'prisma_seed', ok: result.ok, message: result.ok ? (result.output || 'OK') : (result.errorMessage || result.error || 'Gagal') });

  if (result.ok) {
    jobStore.updateJob(jobId, { status: 'success', message: 'Seed berhasil dijalankan.' });
    process.exit(0);
  } else {
    fail('Seed gagal dijalankan - lihat detail step untuk pesan error.');
  }
} catch (err) {
  fail(`Error tak terduga: ${err.message}`);
}
