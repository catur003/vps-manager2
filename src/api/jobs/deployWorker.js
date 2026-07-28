/**
 * Dijalankan via `child_process.fork()`, BUKAN di-require langsung dari
 * route - ini proses Node terpisah. Alasannya: src/utils/shell.js pakai
 * execSync/spawnSync (blocking), dan deploy bisa makan waktu menitan. Kalau
 * dijalanin di process API yang sama, event loop API ke-block total selama
 * itu (API gak bisa jawab request lain, termasuk polling GET /jobs/:id).
 * Dengan fork(), OS yang mecah kerjaan ke process lain - API tetap bebas.
 *
 * Terima jobId lewat argv, baca detail job (params) dari jobStore sendiri
 * (bukan lewat IPC) - lebih simpel dan job tetap "sumber kebenaran tunggal".
 */
const jobStore = require('./jobStore');
const deployNew = require('../../deploy/deployNew');

const jobId = process.argv[2];

function fail(message, stoppedAtKey = null) {
  jobStore.updateJob(jobId, { status: 'failed', message, stoppedAtKey });
  process.exit(1);
}

if (!jobId) {
  console.error('deployWorker: jobId tidak disertakan.');
  process.exit(1);
}

const job = jobStore.getJob(jobId);
if (!job) {
  console.error(`deployWorker: job ${jobId} tidak ditemukan di jobStore.`);
  process.exit(1);
}

jobStore.updateJob(jobId, { status: 'running', message: 'Deploy sedang berjalan...' });

try {
  const result = deployNew.deployNextJs(job.params, (stepName, ok, message) => {
    jobStore.appendJobStep(jobId, { step: stepName, ok, message });
  });

  if (result.ok) {
    jobStore.updateJob(jobId, { status: 'success', message: `Deploy "${job.params.name}" berhasil.` });
    process.exit(0);
  } else {
    // stoppedAtKey cuma ada kalau gagalnya di tahap finishDeploy (clone udah
    // sukses). Kalau gagal di prepareAndClone (safety check/folder/clone),
    // stoppedAtKey tetap null - artinya job ini TIDAK BISA di-retry (belum
    // ada folder buat dilanjutin), harus deploy ulang dari awal.
    fail(`Deploy berhenti di step "${result.stoppedAt}".`, result.stoppedAtKey || null);
  }
} catch (err) {
  fail(`Error tak terduga: ${err.message}`);
}
