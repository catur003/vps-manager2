/**
 * Sama polanya kayak deployWorker.js - proses fork() terpisah, karena
 * `ssl.issueCertificate()` manggil certbot yang butuh round-trip network
 * (ACME HTTP-01 challenge ke Let's Encrypt), bisa makan waktu 10-30 detik+
 * (atau lebih lama kalau kena rate limit / DNS lambat). Kalau dijalanin
 * langsung di process API, event loop API ke-block selama itu.
 */
const jobStore = require('./jobStore');
const ssl = require('../../ssl/ssl');
const nginx = require('../../nginx/nginx');

const jobId = process.argv[2];

function fail(message) {
  jobStore.updateJob(jobId, { status: 'failed', message });
  process.exit(1);
}

if (!jobId) {
  console.error('sslWorker: jobId tidak disertakan.');
  process.exit(1);
}

const job = jobStore.getJob(jobId);
if (!job) {
  console.error(`sslWorker: job ${jobId} tidak ditemukan di jobStore.`);
  process.exit(1);
}

const { domain, port } = job.params;

jobStore.updateJob(jobId, { status: 'running', message: `Menerbitkan sertifikat SSL untuk "${domain}"...` });

try {
  const issueResult = ssl.issueCertificate(domain);
  jobStore.appendJobStep(jobId, {
    step: 'Terbitkan Sertifikat',
    ok: issueResult.ok,
    message: issueResult.ok ? 'Sertifikat berhasil diterbitkan.' : issueResult.errorMessage,
  });
  if (!issueResult.ok) return fail(`Gagal terbitkan sertifikat: ${issueResult.errorMessage}`);

  const upgradeResult = nginx.upgradeToSSL({
    domain,
    port,
    fullchain: issueResult.fullchain,
    privkey: issueResult.privkey,
  });
  jobStore.appendJobStep(jobId, {
    step: 'Upgrade Nginx ke HTTPS',
    ok: upgradeResult.ok,
    message: upgradeResult.ok ? 'Nginx berhasil diupgrade ke HTTPS.' : upgradeResult.errorMessage,
  });
  if (!upgradeResult.ok) return fail(`Sertifikat terbit tapi gagal upgrade nginx: ${upgradeResult.errorMessage}`);

  jobStore.updateJob(jobId, { status: 'success', message: `SSL untuk "${domain}" aktif.` });
  process.exit(0);
} catch (err) {
  fail(`Error tak terduga: ${err.message}`);
}
