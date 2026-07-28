/**
 * Sama polanya kayak deployWorker.js (proses fork() terpisah), tapi manggil
 * `finishDeploy()` langsung (BUKAN `deployNextJs()`) dengan `resumeFromKey` -
 * artinya prepareAndClone (safety check, mkdir, git clone) TIDAK diulang,
 * karena folder-nya udah ada dari attempt sebelumnya yang gagal di tengah
 * jalan (mis. gagal pas npm install/build/prisma, bukan pas clone).
 */
const jobStore = require('./jobStore');
const deployNew = require('../../deploy/deployNew');

const jobId = process.argv[2];

function fail(message, stoppedAtKey = null) {
  jobStore.updateJob(jobId, { status: 'failed', message, stoppedAtKey });
  process.exit(1);
}

if (!jobId) {
  console.error('retryWorker: jobId tidak disertakan.');
  process.exit(1);
}

const job = jobStore.getJob(jobId);
if (!job) {
  console.error(`retryWorker: job ${jobId} tidak ditemukan di jobStore.`);
  process.exit(1);
}

jobStore.updateJob(jobId, { status: 'running', message: `Retry deploy dari step "${job.params.resumeFromKey}"...` });

try {
  const result = deployNew.finishDeploy(
    job.params,
    (stepName, ok, message) => {
      jobStore.appendJobStep(jobId, { step: stepName, ok, message });
    },
    job.params.resumeFromKey
  );

  if (result.ok) {
    jobStore.updateJob(jobId, { status: 'success', message: `Retry deploy "${job.params.name}" berhasil.` });
    process.exit(0);
  } else {
    fail(`Retry berhenti lagi di step "${result.stoppedAt}".`, result.stoppedAtKey || null);
  }
} catch (err) {
  fail(`Error tak terduga: ${err.message}`);
}
