const path = require('path');
const { fork } = require('child_process');
const express = require('express');
const registry = require('../../registry/registry');
const config = require('../../config/config');
const jobStore = require('../jobs/jobStore');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const { validateName } = require('../../menu/helpers');

const router = express.Router();
const BUILD_WORKER_PATH = path.join(__dirname, '..', 'jobs', 'buildWorker.js');
const SEED_WORKER_PATH = path.join(__dirname, '..', 'jobs', 'seedWorker.js');
const VALID_PRISMA_MODES = ['none', 'generate', 'push', 'push_force', 'migrate'];

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * Resolusi project dari nama - SATU-SATUNYA sumber path/owner yang dipercaya
 * (bukan dari body request), sama prinsipnya kayak resolveProject() di
 * git.routes.js/pm2.routes.js.
 */
function resolveProject(req, res) {
  const { name } = req.params;
  const nameCheck = validateName(name);
  if (nameCheck !== true) {
    res.status(400).json({ success: false, message: nameCheck, code: 'INVALID_INPUT' });
    return null;
  }
  const project = registry.findProject(name);
  if (!project) {
    res.status(404).json({ success: false, message: `Project "${name}" tidak ditemukan di registry.`, code: 'PROJECT_NOT_FOUND' });
    return null;
  }
  return { ...project, deploy_user: project.deploy_user || config.loadConfig().deploy_user };
}

/**
 * POST /:name/build - jalanin kombinasi install/prisma/build/restart PM2
 * secara manual di luar alur Deploy. Job-based (fork buildWorker.js), sama
 * seperti Deploy - command ini bisa makan waktu menitan, gak boleh nge-block
 * API. Balikin jobId, status/progress dipoll lewat GET /jobs/:id yang sudah ada.
 *
 * Setara menu CLI "Git Manager > Install/Build/Restart Manual" yang sebelumnya
 * cuma bisa dari terminal, belum pernah ada API-nya.
 */
router.post('/:name/build', (req, res) => {
  const ACTION = 'build.runManual';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const body = req.body || {};
  const steps = {
    install: Boolean(body.install),
    prismaMode: body.prismaMode || 'none',
    build: Boolean(body.build),
    restartPm2: Boolean(body.restartPm2),
  };

  if (!VALID_PRISMA_MODES.includes(steps.prismaMode)) {
    return res.status(400).json({ success: false, message: `prismaMode harus salah satu dari: ${VALID_PRISMA_MODES.join(', ')}.`, code: 'INVALID_INPUT' });
  }
  if (!steps.install && steps.prismaMode === 'none' && !steps.build && !steps.restartPm2) {
    return res.status(400).json({ success: false, message: 'Pilih minimal 1 step: install, prismaMode, build, atau restartPm2.', code: 'INVALID_INPUT' });
  }

  const params = { projectPath: project.path, deployUser: project.deploy_user, pm2Name: project.name, steps };

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name, steps } });
  const jobId = jobStore.createJob('project_build', params);

  const child = fork(BUILD_WORKER_PATH, [jobId], { detached: true, stdio: 'ignore' });
  child.unref();

  audit.recordEnd(auditId, { success: true, message: `Job ${jobId} dibuat`, durationMs: Date.now() - startedAt });
  res.status(202).json({ success: true, message: 'Build/install manual dimulai. Cek progress lewat GET /jobs/:id.', data: { jobId } });
});

/**
 * POST /:name/seed - jalanin `prisma db seed` secara manual. Dipisah dari
 * /build karena di CLI ini memang menu tersendiri ("Jalankan Seed"), bukan
 * bagian dari alur install/build. Job-based (fork seedWorker.js).
 */
router.post('/:name/seed', (req, res) => {
  const ACTION = 'build.runSeed';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const params = { projectPath: project.path, deployUser: project.deploy_user };

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name } });
  const jobId = jobStore.createJob('project_seed', params);

  const child = fork(SEED_WORKER_PATH, [jobId], { detached: true, stdio: 'ignore' });
  child.unref();

  audit.recordEnd(auditId, { success: true, message: `Job ${jobId} dibuat`, durationMs: Date.now() - startedAt });
  res.status(202).json({ success: true, message: 'Seed dimulai. Cek progress lewat GET /jobs/:id.', data: { jobId } });
});

module.exports = router;
