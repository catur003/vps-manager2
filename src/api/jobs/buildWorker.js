/**
 * Dijalankan via child_process.fork() (pola sama persis dengan
 * deployWorker.js) - install/build project bisa makan waktu menitan, jangan
 * sampai ngeblok event loop API utama.
 *
 * Jalanin step yang diminta SECARA URUT: install -> prisma -> build ->
 * restart PM2. Tiap step opsional (dikontrol dari job.params), berhenti di
 * step pertama yang gagal - step sesudahnya SENGAJA tidak dilanjut (build
 * dari install yang gagal biasanya cuma bakal gagal lagi dengan pesan error
 * yang membingungkan, lebih baik user benerin step yang gagal dulu).
 */
const jobStore = require('./jobStore');
const build = require('../../build/build');
const pm2 = require('../../pm2/pm2');

const jobId = process.argv[2];

function fail(message) {
  jobStore.updateJob(jobId, { status: 'failed', message });
  process.exit(1);
}

if (!jobId) {
  console.error('buildWorker: jobId tidak disertakan.');
  process.exit(1);
}

const job = jobStore.getJob(jobId);
if (!job) {
  console.error(`buildWorker: job ${jobId} tidak ditemukan di jobStore.`);
  process.exit(1);
}

const { projectPath, deployUser, pm2Name, steps } = job.params;

jobStore.updateJob(jobId, { status: 'running', message: 'Build/install sedang berjalan...' });

function runStep(stepName, fn) {
  const result = fn();
  jobStore.appendJobStep(jobId, { step: stepName, ok: result.ok, message: result.ok ? (result.output || 'OK') : (result.errorMessage || result.error || 'Gagal') });
  return result.ok;
}

try {
  if (steps.install) {
    if (!runStep('npm_install', () => build.npmInstall(projectPath, deployUser))) return fail('Berhenti di step "npm install".');
  }

  if (steps.prismaMode && steps.prismaMode !== 'none') {
    const prismaFn = {
      generate: build.prismaGenerate,
      push: build.prismaDbPush,
      push_force: build.prismaDbPushForce,
      migrate: build.prismaMigrateDeploy,
    }[steps.prismaMode];
    if (!prismaFn) return fail(`prismaMode "${steps.prismaMode}" tidak dikenali.`);
    if (!runStep(`prisma_${steps.prismaMode}`, () => prismaFn(projectPath, deployUser))) return fail(`Berhenti di step "prisma ${steps.prismaMode}".`);
  }

  if (steps.build) {
    if (!runStep('npm_build', () => build.npmBuild(projectPath, deployUser))) return fail('Berhenti di step "npm run build".');
  }

  if (steps.restartPm2) {
    if (!runStep('pm2_restart', () => pm2.restart(pm2Name, deployUser))) return fail('Berhenti di step "PM2 restart".');
  }

  jobStore.updateJob(jobId, { status: 'success', message: 'Build/install manual selesai.' });
  process.exit(0);
} catch (err) {
  fail(`Error tak terduga: ${err.message}`);
}
