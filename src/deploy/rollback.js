const config = require('../config/config');
const git = require('../git/git');
const build = require('../build/build');
const pm2 = require('../pm2/pm2');
const notify = require('../notify/notify');
const jobStore = require('../api/jobs/jobStore');
const registry = require('../registry/registry');

/**
 * Rollback ke commit deploy SEBELUMNYA (`project.previousCommit`, ditulis
 * otomatis oleh redeploy.js tiap kali redeploy sukses - lihat catatan di
 * sana). Cuma nyimpen 1 slot "sebelumnya" (bukan history panjang) - cukup
 * buat kasus paling umum "deploy baru rusak, balikin yang tadi", TIDAK bisa
 * mundur >1 langkah. Alurnya SENGAJA disamain persis sama runRedeploy()
 * (checkout -> install -> build -> restart) supaya perilakunya konsisten.
 */
async function runRollback(project, jobId) {
  const deployUser = project.deploy_user || config.loadConfig().deploy_user;
  const report = (step, ok, message) => jobStore.appendJobStep(jobId, { step, ok, message });

  if (!project.previousCommit) {
    jobStore.updateJob(jobId, { status: 'failed', message: `"${project.name}" belum punya history deploy sebelumnya buat di-rollback (baru pertama kali deploy, atau belum pernah redeploy lewat panel ini).` });
    return;
  }

  try {
    jobStore.updateJob(jobId, { status: 'running', message: `Rollback "${project.name}" ke commit sebelumnya...` });

    const commitBeforeRollback = git.getHead(project.path, deployUser);

    const checkoutResult = git.checkout(project.path, project.previousCommit, deployUser);
    report('git_checkout', checkoutResult.ok, checkoutResult.ok ? `Checkout ke ${project.previousCommit.slice(0, 8)}` : checkoutResult.errorMessage);
    if (!checkoutResult.ok) throw new Error(`Git checkout gagal: ${checkoutResult.errorMessage}`);

    const installResult = build.npmInstall(project.path, deployUser);
    report('npm_install', installResult.ok, installResult.ok ? 'OK' : installResult.errorMessage);
    if (!installResult.ok) throw new Error(`npm install gagal: ${installResult.errorMessage}`);

    const buildResult = build.npmBuild(project.path, deployUser);
    report('npm_build', buildResult.ok, buildResult.ok ? 'OK' : buildResult.errorMessage);
    if (!buildResult.ok) throw new Error(`npm build gagal: ${buildResult.errorMessage}`);

    const restartResult = pm2.restart(project.name, deployUser);
    report('pm2_restart', restartResult.ok, restartResult.ok ? 'OK' : restartResult.errorMessage);
    if (!restartResult.ok) throw new Error(`PM2 restart gagal: ${restartResult.errorMessage}`);

    // Tukar posisi: commit yang barusan ditinggalkan jadi "previousCommit"
    // baru - biar rollback bisa di-toggle bolak-balik (rollback lagi =
    // balik ke yang tadi di-rollback), bukan cuma sekali pakai.
    registry.updateProject(project.name, { previousCommit: commitBeforeRollback, currentCommit: project.previousCommit });

    jobStore.updateJob(jobId, { status: 'success', message: `Rollback "${project.name}" berhasil ke commit ${project.previousCommit.slice(0, 8)}.` });
    await notify.notify(`↩️ Rollback berhasil: "${project.name}" ke commit ${project.previousCommit.slice(0, 8)}`);
  } catch (err) {
    jobStore.updateJob(jobId, { status: 'failed', message: err.message });
    await notify.notify(`❌ Rollback gagal: "${project.name}"\n${err.message}`);
  }
}

module.exports = { runRollback };
