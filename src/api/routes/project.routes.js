const express = require('express');
const env = require('../../project/env');
const deleteProject = require('../../project/deleteProject');
const registry = require('../../registry/registry');
const config = require('../../config/config');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const { validateName } = require('../../menu/helpers');
const redeploy = require('../../deploy/redeploy');
const rollback = require('../../deploy/rollback');
const jobStore = require('../jobs/jobStore');

const router = express.Router();

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * Resolusi project (path + deploy_user) dari nama - SATU-SATUNYA sumber
 * path/owner yang dipercaya (bukan dari body request), sama pola dengan
 * resolveProject() di git.routes.js / resolveOwner() di pm2.routes.js.
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

router.get('/:name/env', (req, res) => {
  const ACTION = 'project.readEnv';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name } });
  const result = env.readEnv(project.path, project.deploy_user);
  audit.recordEnd(auditId, { success: result.ok, message: result.ok ? 'OK' : 'Gagal membaca .env', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: 'Gagal membaca .env project.', code: 'READ_ENV_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { content: result.content } });
});

/**
 * Timpa isi .env project. `content` diterima apa adanya (string, boleh
 * kosong/multi-baris) - env.writeEnv() sendiri yang menjamin aman dari
 * command injection (heredoc dengan delimiter random, lihat komentar di
 * src/project/env.js). WAJIB confirm:true karena isi lama hilang permanen.
 */
router.put('/:name/env', (req, res) => {
  const ACTION = 'project.writeEnv';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const project = resolveProject(req, res);
  if (!project) return;

  const { content, confirm } = req.body || {};
  if (typeof content !== 'string') {
    return res.status(400).json({ success: false, message: 'content wajib diisi berupa string (boleh string kosong).', code: 'INVALID_INPUT' });
  }
  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Aksi ini MENIMPA isi .env project "${project.name}" - isi lama hilang permanen. Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name } });
  const result = env.writeEnv(project.path, project.deploy_user, content);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'WRITE_ENV_FAILED' });
  }
  res.json({ success: true, message: `.env project "${project.name}" berhasil ditulis ulang.` });
});

/**
 * Preview dampak delete - dipanggil caller SEBELUM eksekusi biar tau persis
 * apa yang bakal kena (PM2 app, nginx site, database terkait, folder).
 * Read-only, gak perlu confirm.
 */
router.get('/:name/delete-preview', (req, res) => {
  const ACTION = 'project.deletePreview';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name } });
  const result = deleteProject.preview(project);
  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });

  res.json({ success: true, message: 'OK', data: result });
});

/**
 * Eksekusi delete project. Opsi (`deletePm2`/`deleteNginx`/`dropDatabases`/
 * `deleteFolder`) diteruskan apa adanya ke deleteProject.execute() - lihat
 * default masing-masing & alasannya di src/project/deleteProject.js
 * (dropDatabases & deleteFolder default false SENGAJA, harus eksplisit
 * diminta karena paling destruktif). DESTRUKTIF & gak ada undo penuh -
 * WAJIB confirm:true.
 */
router.post('/:name/delete', (req, res) => {
  const ACTION = 'project.delete';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const project = resolveProject(req, res);
  if (!project) return;

  const { deletePm2, deleteNginx, dropDatabases, deleteFolder, confirm } = req.body || {};
  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Aksi ini akan MENGHAPUS project "${project.name}" (PM2/nginx/registry, opsional database & folder) secara PERMANEN. Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const opts = {};
  if (typeof deletePm2 === 'boolean') opts.deletePm2 = deletePm2;
  if (typeof deleteNginx === 'boolean') opts.deleteNginx = deleteNginx;
  if (typeof dropDatabases === 'boolean') opts.dropDatabases = dropDatabases;
  if (typeof deleteFolder === 'boolean') opts.deleteFolder = deleteFolder;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name, opts } });
  const result = deleteProject.execute(project, opts);
  audit.recordEnd(auditId, { success: result.ok, message: result.ok ? 'OK' : 'Sebagian step gagal', durationMs: Date.now() - startedAt });

  res.json({ success: result.ok, message: result.ok ? `Project "${project.name}" berhasil dihapus.` : 'Sebagian step gagal, cek detail per-step.', data: { results: result.results } });
});

/**
 * POST /project/:name/redeploy - tombol manual "Pull & Redeploy" di
 * dashboard (git pull + npm install + npm build + pm2 restart) - alur
 * PERSIS sama dengan yang jalan otomatis lewat webhook GitHub
 * (src/deploy/redeploy.js), cuma dipicu manual dari tombol, bukan push.
 * Berguna buat project yang webhook-nya belum/gak mau disetup, atau buat
 * mancing ulang manual kalau auto-deploy pas itu gagal.
 */
router.post('/:name/redeploy', (req, res) => {
  const ACTION = 'project.redeploy';
  if (!guard(ACTION, res)) return;
  const { name } = req.params;
  const check = validateName(name);
  if (check !== true) return res.status(400).json({ success: false, message: check, code: 'INVALID_INPUT' });

  const project = registry.findProject(name);
  if (!project) {
    return res.status(404).json({ success: false, message: `Project "${name}" tidak ditemukan di registry.`, code: 'PROJECT_NOT_FOUND' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name } });
  const jobId = jobStore.createJob('manual_redeploy', { name: project.name });
  audit.recordEnd(auditId, { success: true, message: `Job ${jobId} dibuat.`, durationMs: Date.now() - startedAt });

  res.status(202).json({ success: true, message: 'Redeploy dimulai di background.', data: { jobId } });
  redeploy.runRedeploy(project, jobId, { triggeredBy: 'manual' });
});

/**
 * POST /project/:name/rollback - balikin project ke commit deploy
 * SEBELUMNYA (`previousCommit`, ditulis otomatis tiap redeploy sukses).
 * WAJIB confirm:true - ini checkout+rebuild+restart, dampaknya sama besar
 * kayak redeploy (bedanya arah, mundur bukan maju), gak instant-reversible.
 */
router.post('/:name/rollback', (req, res) => {
  const ACTION = 'project.rollback';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  const { name } = req.params;
  const check = validateName(name);
  if (check !== true) return res.status(400).json({ success: false, message: check, code: 'INVALID_INPUT' });

  const project = registry.findProject(name);
  if (!project) {
    return res.status(404).json({ success: false, message: `Project "${name}" tidak ditemukan di registry.`, code: 'PROJECT_NOT_FOUND' });
  }
  if (!project.previousCommit) {
    return res.status(400).json({ success: false, message: `"${name}" belum punya history deploy sebelumnya buat di-rollback.`, code: 'NO_ROLLBACK_TARGET' });
  }
  if (policy.confirmRequired && req.body?.confirm !== true) {
    return res.status(400).json({ success: false, message: `Kirim ulang dengan { "confirm": true } untuk rollback "${name}" ke commit ${project.previousCommit.slice(0, 8)}.`, code: 'CONFIRM_REQUIRED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name, targetCommit: project.previousCommit } });
  const jobId = jobStore.createJob('rollback', { name: project.name });
  audit.recordEnd(auditId, { success: true, message: `Job ${jobId} dibuat.`, durationMs: Date.now() - startedAt });

  res.status(202).json({ success: true, message: 'Rollback dimulai di background.', data: { jobId } });
  rollback.runRollback(project, jobId);
});

/**
 * PATCH /project/:name/webhook - toggle on/off auto-deploy via webhook
 * GitHub buat project ini (opt-in per project, lihat catatan di
 * webhook.routes.js soal alasannya default OFF).
 */
router.patch('/:name/webhook', (req, res) => {
  const ACTION = 'project.webhookToggle';
  if (!guard(ACTION, res)) return;
  const { name } = req.params;
  const check = validateName(name);
  if (check !== true) return res.status(400).json({ success: false, message: check, code: 'INVALID_INPUT' });

  const project = registry.findProject(name);
  if (!project) {
    return res.status(404).json({ success: false, message: `Project "${name}" tidak ditemukan di registry.`, code: 'PROJECT_NOT_FOUND' });
  }
  const enabled = req.body?.enabled === true;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name, enabled } });
  registry.updateProject(name, { webhook_enabled: enabled });
  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });

  res.json({ success: true, message: `Webhook untuk "${name}" ${enabled ? 'diaktifkan' : 'dinonaktifkan'}.` });
});

module.exports = router;
