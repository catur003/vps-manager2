const express = require('express');
const git = require('../../git/git');
const registry = require('../../registry/registry');
const config = require('../../config/config');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const { validateName } = require('../../menu/helpers');

const router = express.Router();

// Nama branch git - whitelist ketat. Sejak Fase 3.1, git.checkout() sudah
// pakai execFileSync (argv terpisah) jadi akar celahnya sudah tertutup -
// regex ini sekarang defense-in-depth (validasi awal, pesan error jelas ke
// caller), bukan lagi satu-satunya penutup celah. Lihat catatan di bagian
// bawah file.
const BRANCH_REGEX = /^[a-zA-Z0-9/_.-]+$/;

// FIX: manualUrl di POST /:name/credentials sebelumnya TANPA validasi
// apapun sebelum nyampe git.setRemoteUrl() - satu-satunya penutup celah
// waktu itu adalah runAsUserArgs() di sisi git.js. Sekarang runAsUserArgs()
// sudah bener (execFileSync, argv terpisah), regex ini jadi lapisan KEDUA
// (defense-in-depth) - pola sama kayak GIT_REPO_REGEX di deploy.routes.js.
const GIT_URL_REGEX = /^(https?:\/\/|git@)[a-zA-Z0-9_.@:/-]+$/;

function isValidBranch(branch) {
  if (!branch || typeof branch !== 'string') return false;
  if (!BRANCH_REGEX.test(branch)) return false;
  if (branch.startsWith('-')) return false; // cegah disalahartikan sebagai flag git
  if (branch.includes('..')) return false; // cegah path traversal / range syntax nyasar
  return true;
}

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * Resolusi project (path + deploy_user) dari nama - SATU-SATUNYA sumber
 * path/owner yang dipercaya (bukan dari body request), sama prinsipnya kayak
 * resolveOwner() di pm2.routes.js.
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
  // Fallback ke deploy_user default Configuration - sama seperti pola yang
  // sudah dipakai mainMenu.js (`project.deploy_user || config.loadConfig().deploy_user`),
  // buat jaga-jaga entry registry lama yang belum punya field ini.
  return { ...project, deploy_user: project.deploy_user || config.loadConfig().deploy_user };
}

router.get('/:name/status', (req, res) => {
  const ACTION = 'git.status';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name } });

  const result = git.status(project.path, project.deploy_user);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'GIT_STATUS_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: result });
});

router.get('/:name/branches', (req, res) => {
  const ACTION = 'git.listBranches';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name } });

  const result = git.listBranches(project.path, project.deploy_user);
  audit.recordEnd(auditId, { success: result.ok, message: result.error || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.error, code: 'GIT_BRANCHES_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { branches: result.branches } });
});

/**
 * `limit` dibatasi 1-200 (default 10) - divalidasi sebagai integer murni
 * SEBELUM disisipkan ke command `git log -n <limit>` (lihat catatan BRANCH_REGEX
 * di atas soal kenapa ini penting).
 */
router.get('/:name/log', (req, res) => {
  const ACTION = 'git.log';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 10;
  limit = Math.min(limit, 200);

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name, limit } });

  const result = git.log(project.path, project.deploy_user, limit);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'GIT_LOG_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { limit, output: result.output } });
});

/**
 * Pull. `accountLabel` opsional di body - kalau diisi & cocok dengan salah
 * satu akun tersimpan di Configuration, token-nya di-embed SEMENTARA ke
 * remote URL cuma buat durasi pull ini (logic-nya sudah ada di git.pull(),
 * tidak diubah).
 */
router.post('/:name/pull', (req, res) => {
  const ACTION = 'git.pull';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const { accountLabel } = req.body || {};
  let account = null;
  if (accountLabel) {
    account = config.listGithubAccounts().find((a) => a.label === accountLabel) || null;
    if (!account) {
      return res.status(400).json({ success: false, message: `Akun GitHub dengan label "${accountLabel}" tidak ditemukan di Configuration.`, code: 'ACCOUNT_NOT_FOUND' });
    }
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name, accountLabel } });

  const result = git.pull(project.path, project.deploy_user, account);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || result.output || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'GIT_PULL_FAILED' });
  }
  res.json({ success: true, message: 'Pull berhasil.', data: { output: result.output } });
});

/**
 * Checkout branch. `branch` WAJIB lolos `isValidBranch()` di atas.
 */
router.post('/:name/checkout', (req, res) => {
  const ACTION = 'git.checkout';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const { branch } = req.body || {};
  if (!isValidBranch(branch)) {
    return res.status(400).json({
      success: false,
      message: 'branch wajib diisi, hanya huruf/angka/underscore/dash/titik/slash, tidak boleh diawali "-" atau mengandung "..".',
      code: 'INVALID_INPUT',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name, branch } });

  const result = git.checkout(project.path, branch, project.deploy_user);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'GIT_CHECKOUT_FAILED' });
  }
  res.json({ success: true, message: `Berhasil checkout ke branch "${branch}".`, data: { output: result.output } });
});

/**
 * Stash perubahan lokal yang belum di-commit. Gak destruktif permanen (bisa
 * di-`stash pop` lagi manual di server), jadi gak perlu confirm.
 */
router.post('/:name/stash', (req, res) => {
  const ACTION = 'git.stash';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name } });

  const result = git.stash(project.path, project.deploy_user);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'GIT_STASH_FAILED' });
  }
  res.json({ success: true, message: 'Perubahan lokal berhasil di-stash.', data: { output: result.output } });
});

/**
 * POST /:name/force-sync - jalan keluar buat kondisi yang GAK BISA
 * diselesaikan lewat /pull atau /stash (unmerged files/conflict) - lihat
 * catatan lengkap di git.forceSyncToRemote(). DESTRUKTIF, wajib
 * { confirm: true } di body (lihat commandPolicy.js - confirmRequired).
 */
router.post('/:name/force-sync', (req, res) => {
  const ACTION = 'git.forceSyncToRemote';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const project = resolveProject(req, res);
  if (!project) return;

  const { confirm } = req.body || {};
  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Ini akan MEMBUANG semua perubahan lokal di project "${project.name}" (termasuk file yang lagi conflict) dan menyamakan paksa ke branch remote. Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name } });

  const result = git.forceSyncToRemote(project.path, project.deploy_user);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'GIT_FORCE_SYNC_FAILED' });
  }
  res.json({ success: true, message: 'Working tree berhasil disamakan paksa ke branch remote.', data: { output: result.output } });
});

/**
 * POST /:name/credentials - ganti remote URL repo (dipakai kalau PAT lama
 * expired/direvoke, atau mau pindah akun GitHub buat repo yang sama). Ini
 * BEDA dari /config/github (config.routes.js) yang cuma nyimpen daftar akun -
 * endpoint ini yang beneran APPLY salah satu akun tersimpan (atau URL manual)
 * ke remote origin project ini. Sesuai fungsi "Update Kredensial GitHub" yang
 * sudah ada di CLI (mainMenu.js baris ~848) tapi belum pernah di-expose lewat API.
 * Gampang diulang/gak ngerusak data lain kalau salah, jadi gak perlu confirm.
 */
router.post('/:name/credentials', (req, res) => {
  const ACTION = 'git.updateCredentials';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req, res);
  if (!project) return;

  const { accountLabel, manualUrl } = req.body || {};
  if (!accountLabel && !manualUrl) {
    return res.status(400).json({
      success: false,
      message: 'Kirim salah satu: accountLabel (akun GitHub tersimpan) atau manualUrl.',
      code: 'INVALID_INPUT',
    });
  }
  // FIX: manualUrl sebelumnya lolos ke git.setRemoteUrl() tanpa validasi
  // format apapun - lihat catatan GIT_URL_REGEX di atas.
  if (manualUrl && (typeof manualUrl !== 'string' || !GIT_URL_REGEX.test(manualUrl))) {
    return res.status(400).json({
      success: false,
      message: 'manualUrl wajib URL git yang valid (https:// atau git@).',
      code: 'INVALID_INPUT',
    });
  }

  let targetUrl = manualUrl;
  if (accountLabel) {
    const account = config.listGithubAccounts().find((a) => a.label === accountLabel);
    if (!account) {
      return res.status(404).json({ success: false, message: `Akun "${accountLabel}" tidak ditemukan di Configuration.`, code: 'ACCOUNT_NOT_FOUND' });
    }
    const baseUrl = manualUrl || git.getRemoteUrl(project.path, project.deploy_user);
    if (!baseUrl) {
      return res.status(400).json({ success: false, message: 'Gagal membaca remote URL repo saat ini.', code: 'GIT_REMOTE_READ_FAILED' });
    }
    targetUrl = git.buildAuthenticatedUrl(baseUrl, account);
  }

  const startedAt = Date.now();
  // URL disimpan ke audit TANPA token - buildAuthenticatedUrl() nyelipin
  // token ke targetUrl, jadi wajib di-strip dulu sebelum masuk log.
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name, url: git.stripCredentials(targetUrl || '') } });

  const result = git.setRemoteUrl(project.path, targetUrl, project.deploy_user);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'GIT_CREDENTIALS_UPDATE_FAILED' });
  }
  res.json({ success: true, message: 'Kredensial GitHub untuk project ini berhasil diperbarui.' });
});

module.exports = router;

/**
 * Security note (Fase 3.1 - FIXED): `git.js` (checkout/log/diffNameOnly)
 * sekarang pakai shell.runAsUserArgs() (execFileSync, argv terpisah), bukan
 * lagi shell.runAsUser() dengan string interpolation - akar celah command
 * injection sudah ditutup, sama pola dengan nginx.js Fase 2.1. BRANCH_REGEX
 * & integer-only limit di atas tetap dipertahankan sebagai defense-in-depth
 * (validasi awal sebelum request masuk lebih dalam), bukan lagi satu-satunya
 * penutup celah.
 */
