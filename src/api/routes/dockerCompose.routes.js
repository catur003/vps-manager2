const path = require('path');
const { fork } = require('child_process');
const express = require('express');
const config = require('../../config/config');
const git = require('../../git/git');
const dockerCompose = require('../../docker/dockerCompose');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const jobStore = require('../jobs/jobStore');

const router = express.Router();
const WORKER_PATH = path.join(__dirname, '..', 'jobs', 'composeDeployWorker.js');
const FOLDER_PATH_REGEX = /^\/[a-zA-Z0-9_\-./]+$/;
const GIT_REPO_REGEX = /^(https?:\/\/|git@)[a-zA-Z0-9_.@:/-]+$/;

function validateBody(body) {
  if (!body.stackName || !dockerCompose.isValidStackName(body.stackName)) {
    return 'stackName wajib diisi, hanya huruf/angka/underscore/dash.';
  }
  if (!body.gitRepo || !GIT_REPO_REGEX.test(body.gitRepo)) return 'gitRepo wajib URL git yang valid.';
  if (!body.folderPath || !FOLDER_PATH_REGEX.test(body.folderPath)) return 'folderPath wajib absolute path.';
  if (!Number.isInteger(body.port) || body.port <= 0) return 'port wajib angka bulat positif.';
  return true;
}

/**
 * POST / - deploy stack baru dari git repo (build Dockerfile otomatis kalau
 * belum ada, docker compose build+up). Async lewat job/fork, sama pola
 * dengan POST /deploy (deploy PM2 biasa) - build bisa makan waktu menitan.
 */
router.post('/', (req, res) => {
  const ACTION = 'dockerCompose.deploy';
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const validation = validateBody(req.body || {});
  if (validation !== true) {
    return res.status(400).json({ success: false, message: validation, code: 'INVALID_INPUT' });
  }

  const cfg = config.loadConfig();

  // Repo private butuh credential (PAT) - sama mekanismenya kayak deploy
  // PM2 biasa (deploy.routes.js buildCloneUrl): user pilih akun GitHub yang
  // udah disimpan di Configuration > GitHub Accounts lewat githubAccountLabel,
  // token-nya disisipkan ke URL clone SEBELUM masuk job (jadi worker-nya
  // sendiri gak perlu tau soal akun/token sama sekali).
  let cloneUrl = req.body.gitRepo;
  if (req.body.githubAccountLabel) {
    const account = config.listGithubAccounts().find((a) => a.label === req.body.githubAccountLabel);
    if (!account) {
      return res.status(400).json({
        success: false,
        message: `Akun GitHub berlabel "${req.body.githubAccountLabel}" tidak ditemukan di Configuration > GitHub Accounts.`,
        code: 'GITHUB_ACCOUNT_NOT_FOUND',
      });
    }
    cloneUrl = git.buildAuthenticatedUrl(req.body.gitRepo, account);
  }

  const params = {
    stackName: req.body.stackName,
    gitRepo: req.body.gitRepo,
    cloneUrl,
    branch: req.body.branch || cfg.git_branch,
    folderPath: req.body.folderPath,
    deployUser: req.body.deployUser || cfg.deploy_user,
    port: req.body.port,
    includeMysql: Boolean(req.body.includeMysql),
    includeRedis: Boolean(req.body.includeRedis),
  };

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params });
  const jobId = jobStore.createJob('docker_compose_deploy', params);

  const child = fork(WORKER_PATH, [jobId], { detached: true, stdio: 'ignore' });
  child.unref();

  audit.recordEnd(auditId, { success: true, message: `Job ${jobId} dibuat.`, durationMs: Date.now() - startedAt });
  res.status(202).json({ success: true, message: 'Docker deploy dimulai di background. Cek progress lewat GET /jobs/:id.', data: { jobId } });
});

/**
 * GET / - list semua stack docker-compose yang ada di folder default.
 */
router.get('/', (req, res) => {
  const ACTION = 'dockerCompose.list';
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const cfg = config.loadConfig();
  const result = dockerCompose.listStacks(cfg.default_folder, cfg.deploy_user);
  if (!result.ok) return res.status(500).json({ success: false, message: result.errorMessage, code: 'LIST_STACKS_FAILED' });
  res.json({ success: true, message: 'OK', data: { stacks: result.stacks } });
});

/**
 * POST /:action - kontrol stack (down/restart/logs). `folderPath` dikirim di
 * body (bukan dari registry - stack docker-compose gak masuk registry.json
 * biasa) - validasi format path sama seperti endpoint deploy.
 */
router.post('/action/:action', (req, res) => {
  const ACTION = 'dockerCompose.action';
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const { folderPath } = req.body || {};
  if (!folderPath || !FOLDER_PATH_REGEX.test(folderPath)) {
    return res.status(400).json({ success: false, message: 'folderPath wajib absolute path.', code: 'INVALID_INPUT' });
  }
  const result = dockerCompose.composeAction(folderPath, req.params.action);
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'COMPOSE_ACTION_FAILED' });
  res.json({ success: true, message: 'OK', data: { output: result.output } });
});

module.exports = router;
