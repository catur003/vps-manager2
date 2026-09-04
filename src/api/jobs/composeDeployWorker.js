/**
 * Sama pola dengan deployWorker.js - proses fork() terpisah karena
 * `docker compose build` bisa makan waktu menitan (image pull, composer/npm
 * install DI DALAM container).
 */
const jobStore = require('./jobStore');
const dockerCompose = require('../../docker/dockerCompose');
const notify = require('../../notify/notify');

const jobId = process.argv[2];

if (!jobId) { console.error('composeDeployWorker: jobId tidak disertakan.'); process.exit(1); }

const job = jobStore.getJob(jobId);
if (!job) { console.error(`composeDeployWorker: job ${jobId} tidak ditemukan.`); process.exit(1); }

jobStore.updateJob(jobId, { status: 'running', message: 'Docker compose deploy sedang berjalan...' });

try {
  const result = dockerCompose.deployCompose(job.params, (step, ok, message) => {
    jobStore.appendJobStep(jobId, { step, ok, message });
  });

  if (result.ok) {
    const dbNote = result.dbCreds
      ? `\nDB: ${result.dbCreds.database} / user: ${result.dbCreds.user}  (password hanya ditampilkan sekali saat provisioning)`
      : '';
    jobStore.updateJob(jobId, { status: 'success', message: `Stack "${job.params.stackName}" berhasil jalan (${result.framework}).${dbNote}` });
    notify.notify(`✅ Docker deploy berhasil: "${job.params.stackName}" (${result.framework})`).finally(() => process.exit(0));
  } else {
    jobStore.updateJob(jobId, { status: 'failed', message: `Deploy berhenti di step "${result.stoppedAt}".` });
    notify.notify(`❌ Docker deploy gagal: "${job.params.stackName}" di step "${result.stoppedAt}"`).finally(() => process.exit(1));
  }
} catch (err) {
  jobStore.updateJob(jobId, { status: 'failed', message: `Error tak terduga: ${err.message}` });
  notify.notify(`❌ Docker deploy error: "${job.params.stackName}"\n${err.message}`).finally(() => process.exit(1));
}
