const config = require('../config/config');
const git = require('../git/git');
const build = require('../build/build');
const pm2 = require('../pm2/pm2');
const notify = require('../notify/notify');
const jobStore = require('../api/jobs/jobStore');
const registry = require('../registry/registry');

/**
 * Pull + install + build + restart 1 project yang SUDAH ada (bukan deploy
 * dari nol) - dipakai DUA tempat: webhook GitHub otomatis (webhook.routes.js)
 * dan tombol "Pull & Redeploy" manual di dashboard (project.routes.js).
 * Disatuin di sini biar dua jalur itu gak bisa diverge/beda perilaku diam-diam.
 */
async function runRedeploy(project, jobId, { triggeredBy = 'manual' } = {}) {
  const deployUser = project.deploy_user || config.loadConfig().deploy_user;
  const report = (step, ok, message) => jobStore.appendJobStep(jobId, { step, ok, message });

  try {
    jobStore.updateJob(jobId, { status: 'running', message: `Redeploy "${project.name}" (${triggeredBy})...` });

    // Catat commit SEBELUM pull - ini yang jadi target "Rollback" kalau
    // deploy setelah ini ternyata rusak (lihat src/deploy/rollback.js).
    // Diambil di awal (bukan dari field registry yang mungkin basi kalau
    // history sebelumnya gagal ditulis) biar selalu akurat.
    const commitBeforePull = git.getHead(project.path, deployUser);

    const pullResult = git.pull(project.path, deployUser);
    report('git_pull', pullResult.ok, pullResult.ok ? pullResult.output : pullResult.errorMessage);
    if (!pullResult.ok) throw new Error(`Git pull gagal: ${pullResult.errorMessage}`);

    const installResult = build.npmInstall(project.path, deployUser);
    report('npm_install', installResult.ok, installResult.ok ? 'OK' : installResult.errorMessage);
    if (!installResult.ok) throw new Error(`npm install gagal: ${installResult.errorMessage}`);

    const buildResult = build.npmBuild(project.path, deployUser);
    report('npm_build', buildResult.ok, buildResult.ok ? 'OK' : buildResult.errorMessage);
    if (!buildResult.ok) throw new Error(`npm build gagal: ${buildResult.errorMessage}`);

    const restartResult = pm2.restart(project.name, deployUser);
    report('pm2_restart', restartResult.ok, restartResult.ok ? 'OK' : restartResult.errorMessage);
    if (!restartResult.ok) throw new Error(`PM2 restart gagal: ${restartResult.errorMessage}`);

    // Simpan commit sebelum pull sebagai "previousCommit" (target rollback)
    // HANYA kalau beda dari commit baru - kalau `git pull` gak ngubah apa-apa
    // (udah paling baru), jangan timpa previousCommit yang valid dgn commit
    // yang sama (bikin rollback jadi no-op/percuma).
    const commitAfterPull = git.getHead(project.path, deployUser);
    if (commitBeforePull && commitAfterPull && commitBeforePull !== commitAfterPull) {
      try {
        registry.updateProject(project.name, { previousCommit: commitBeforePull, currentCommit: commitAfterPull });
      } catch (err) {
        // project mungkin bukan project ter-registrasi (mis. dipanggil dari
        // konteks lain) - gak fatal, rollback based on commit history cuma
        // gak akan tersedia buat project ini.
      }
    }

    jobStore.updateJob(jobId, { status: 'success', message: `Redeploy "${project.name}" berhasil (${triggeredBy}).` });
    await notify.notify(`✅ Redeploy berhasil: "${project.name}" (${triggeredBy})`);
  } catch (err) {
    jobStore.updateJob(jobId, { status: 'failed', message: err.message });
    await notify.notify(`❌ Redeploy gagal: "${project.name}" (${triggeredBy})\n${err.message}`);
  }
}

module.exports = { runRedeploy };
