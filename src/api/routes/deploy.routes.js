const path = require('path');
const { fork } = require('child_process');
const express = require('express');
const config = require('../../config/config');
const git = require('../../git/git');
const jobStore = require('../jobs/jobStore');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const { validateName, validateDomainRequired } = require('../../menu/helpers');

const router = express.Router();
const ACTION = 'deploy.deployNextJs';
const WORKER_PATH = path.join(__dirname, '..', 'jobs', 'deployWorker.js');
const RETRY_WORKER_PATH = path.join(__dirname, '..', 'jobs', 'retryWorker.js');
const VALID_PRISMA_MODES = ['none', 'generate', 'push', 'push_force', 'migrate'];

// Field-field ini dieksekusi lewat execFileSync (bukan shell) di deployNew.js
// jadi TIDAK BISA lagi memicu command injection walau isinya aneh. Regex di
// bawah ini murni lapisan validasi KEDUA (defense-in-depth, bukan satu-
// satunya pertahanan) - tujuannya nolak input yang jelas bukan nilai wajar
// (path relatif, username sistem yang aneh, URL bukan git, dll) sedari awal
// dengan pesan error yang jelas, bukan gagal belakangan di step deploy.
const DEPLOY_USER_REGEX = /^[a-z_][a-z0-9_-]{0,31}$/; // aturan username Linux standar
const BRANCH_REGEX = /^[a-zA-Z0-9._/-]+$/;
const FOLDER_PATH_REGEX = /^\/[a-zA-Z0-9_\-./]+$/; // wajib absolute path
const GIT_REPO_REGEX = /^(https?:\/\/|git@)[a-zA-Z0-9_.@:/-]+$/;

function validateBody(body) {
  const nameCheck = validateName(body.name);
  if (nameCheck !== true) return nameCheck;

  const domainCheck = validateDomainRequired(body.domain);
  if (domainCheck !== true) return domainCheck;

  if (!body.gitRepo || typeof body.gitRepo !== 'string' || !GIT_REPO_REGEX.test(body.gitRepo)) {
    return 'gitRepo wajib diisi, harus URL git yang valid (https:// atau git@).';
  }
  if (!Number.isInteger(body.port) || body.port <= 0) return 'port wajib angka bulat positif.';
  if (!body.folderPath || typeof body.folderPath !== 'string' || !FOLDER_PATH_REGEX.test(body.folderPath)) {
    return 'folderPath wajib diisi, harus absolute path (diawali "/") dan hanya boleh huruf/angka/underscore/dash/titik/slash.';
  }
  if (body.branch && (typeof body.branch !== 'string' || !BRANCH_REGEX.test(body.branch))) {
    return 'branch hanya boleh huruf/angka/titik/dash/underscore/slash.';
  }
  if (body.deployUser && (typeof body.deployUser !== 'string' || !DEPLOY_USER_REGEX.test(body.deployUser))) {
    return 'deployUser harus nama username Linux yang valid.';
  }

  // Kalau typo (mis. "pusg") dibiarkan lolos, buildFinishSteps() di deployNew.js
  // diam-diam SKIP step prisma tanpa error - user baru sadar belakangan pas
  // app-nya gagal connect DB. Tolak dari awal biar jelas.
  if (body.prismaMode && !VALID_PRISMA_MODES.includes(body.prismaMode)) {
    return `prismaMode harus salah satu dari: ${VALID_PRISMA_MODES.join(', ')}.`;
  }

  // Opsional - dipakai buat repo private (lihat buildCloneUrl() di bawah).
  // Cuma validasi tipe di sini; validasi "akun ini beneran ada" dilakukan
  // belakangan di handler (butuh baca config, bukan validasi statis body).
  if (body.githubAccountLabel !== undefined && typeof body.githubAccountLabel !== 'string') {
    return 'githubAccountLabel harus berupa teks.';
  }

  return true;
}

/**
 * FIX: sebelumnya endpoint ini TIDAK PERNAH menyisipkan credential GitHub ke
 * cloneUrl sama sekali - beda dengan menu CLI (mainMenu.js) yang sudah benar
 * nanya akun tersimpan lalu build authenticated URL. Akibatnya semua deploy
 * repo PRIVATE lewat API/app selalu gagal di step "Git Clone" dengan error
 * "could not read Username for 'https://github.com'", walau akun GitHub-nya
 * sudah tersimpan di Configuration.
 *
 * Return { ok: true, cloneUrl } atau { ok: false, message } (label dikirim
 * tapi akunnya gak ketemu - jangan diam-diam lanjut clone tanpa auth, karena
 * hasilnya bakal gagal lagi dengan error yang membingungkan).
 */
function buildCloneUrl(gitRepo, githubAccountLabel) {
  if (!githubAccountLabel) return { ok: true, cloneUrl: gitRepo };
  const account = config.listGithubAccounts().find((a) => a.label === githubAccountLabel);
  if (!account) {
    return {
      ok: false,
      message: `Akun GitHub berlabel "${githubAccountLabel}" tidak ditemukan di Configuration. Tambah dulu lewat menu Setting > GitHub, atau deploy tanpa memilih akun kalau repo-nya publik.`,
    };
  }
  return { ok: true, cloneUrl: git.buildAuthenticatedUrl(gitRepo, account) };
}

router.post('/', (req, res) => {
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const validation = validateBody(req.body || {});
  if (validation !== true) {
    return res.status(400).json({ success: false, message: validation, code: 'INVALID_INPUT' });
  }

  const cloneUrlResult = buildCloneUrl(req.body.gitRepo, req.body.githubAccountLabel);
  if (!cloneUrlResult.ok) {
    return res.status(400).json({ success: false, message: cloneUrlResult.message, code: 'GITHUB_ACCOUNT_NOT_FOUND' });
  }

  const cfg = config.loadConfig();
  const params = {
    name: req.body.name,
    gitRepo: req.body.gitRepo,
    // cloneUrl (kalau ada akun terpilih) = gitRepo + username:token disisipkan -
    // dipakai KHUSUS buat command clone (lihat prepareAndClone() di deployNew.js).
    // gitRepo yang bersih tetap yang disimpan ke registry & steps/log biar
    // token gak nyangkut di tempat lain. jobStore.js sudah di-update supaya
    // field ini ikut di-redact dari response API (sensitif, sama kayak token).
    cloneUrl: cloneUrlResult.cloneUrl,
    branch: req.body.branch || cfg.git_branch,
    domain: req.body.domain,
    port: req.body.port,
    folderPath: req.body.folderPath,
    deployUser: req.body.deployUser || cfg.deploy_user,
    envContent: req.body.envContent || '',
    prismaMode: req.body.prismaMode || 'none',
  };

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params });
  const jobId = jobStore.createJob('deploy_nextjs', params);

  // fork() = proses Node BARU, terpisah dari API. API langsung lanjut ke
  // res.json() di bawah tanpa nunggu deploy selesai - event loop API gak
  // ke-block. `detached: true` + `unref()` biar worker gak "nahan" proses
  // API tetap hidup (worker jalan mandiri, statusnya dibaca dari jobs.json).
  const child = fork(WORKER_PATH, [jobId], { detached: true, stdio: 'ignore' });
  child.unref();

  audit.recordEnd(auditId, { success: true, message: `Job ${jobId} dibuat, deploy jalan di background.`, durationMs: Date.now() - startedAt });

  res.status(202).json({
    success: true,
    message: 'Deploy dimulai di background. Cek progress lewat GET /jobs/:id.',
    data: { jobId },
  });
});

module.exports = router;

// Urutan step SETELAH clone (persis urutan di buildFinishSteps() /
// deployNew.js) - dipakai buat mikirin "kalau field X di-override pas retry,
// step paling awal mana yang WAJIB diulang biar override itu beneran
// kepakai (bukan cuma nyambung dari step gagal asli yang udah lewatin step
// itu)".
const RESUME_STEP_ORDER = ['env', 'install', 'prisma', 'build', 'pm2_start', 'pm2_save', 'nginx', 'registry'];
function stepRank(key) {
  // BUG FIX: key prisma ('prisma_generate'/'prisma_push'/'prisma_migrate',
  // beda-beda sesuai mode) sebelumnya TIDAK dimasukin ke RESUME_STEP_ORDER
  // sama sekali, jadi fallback "key gak dikenal" (return 0) kepakai buat
  // prisma - PERSIS SAMA rank-nya kayak 'env' (juga 0). Efeknya FATAL:
  // pas retry gagal lagi di step prisma, forcedEarliestKeys=['env'] gak
  // pernah menang lawan originalJob.stoppedAtKey='prisma_push' karena
  // reduce()-nya pakai `<` (strict less-than) - 0 < 0 = false. Akibatnya
  // envContent yang baru diketik user gak pernah dipaksa nulis ulang step
  // 'env' - retry langsung lanjut ke prisma dengan .env LAMA, walau user
  // udah jelas-jelas ngedit .env sebelum retry. Sekarang prisma_* dikasih
  // posisi asli (antara install & build, sesuai urutan run-nya beneran di
  // buildFinishSteps()), bukan numpang di rank 0.
  if (typeof key === 'string' && key.startsWith('prisma_')) return RESUME_STEP_ORDER.indexOf('prisma');
  const idx = RESUME_STEP_ORDER.indexOf(key);
  return idx === -1 ? 0 : idx; // key BENERAN gak dikenal -> paling awal, restart aman
}

// Field yang boleh di-override pas retry - SENGAJA dibatasi cuma yang aman
// diubah setelah folder sudah ke-clone (step-step SETELAH clone: tulis .env,
// build, pm2, nginx). `name`, `gitRepo`, `folderPath` TIDAK boleh diubah di
// sini karena folder & identitas project udah kepatri dari attempt pertama -
// ganti itu di tengah jalan bakal bikin state gak konsisten (folder lama
// vs nama/repo baru). `deployUser` juga sengaja gak boleh diubah - folder
// hasil clone attempt pertama udah ke-chown ke deployUser LAMA, ganti user
// di retry bakal bikin PM2/build jalan sebagai user yang gak punya izin
// tulis di folder itu.
function validateRetryOverrides(body) {
  const overrides = {};
  if (body.envContent !== undefined) {
    if (typeof body.envContent !== 'string') return { error: 'envContent harus berupa teks.' };
    overrides.envContent = body.envContent;
  }
  if (body.port !== undefined) {
    if (!Number.isInteger(body.port) || body.port <= 0) return { error: 'port wajib angka bulat positif.' };
    overrides.port = body.port;
  }
  if (body.domain !== undefined) {
    const domainCheck = validateDomainRequired(body.domain);
    if (domainCheck !== true) return { error: domainCheck };
    overrides.domain = body.domain;
  }
  if (body.branch !== undefined) {
    if (typeof body.branch !== 'string' || !BRANCH_REGEX.test(body.branch)) {
      return { error: 'branch hanya boleh huruf/angka/titik/dash/underscore/slash.' };
    }
    overrides.branch = body.branch;
  }
  if (body.prismaMode !== undefined) {
    if (!VALID_PRISMA_MODES.includes(body.prismaMode)) {
      return { error: `prismaMode harus salah satu dari: ${VALID_PRISMA_MODES.join(', ')}.` };
    }
    overrides.prismaMode = body.prismaMode;
  }
  return { overrides };
}

router.post('/:jobId/retry', (req, res) => {
  const RETRY_ACTION = 'deploy.retry';
  if (!commandPolicy.isExposed(RETRY_ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const originalJob = jobStore.getJob(req.params.jobId);
  if (!originalJob) {
    return res.status(404).json({ success: false, message: 'Job asli tidak ditemukan.', code: 'JOB_NOT_FOUND' });
  }
  // FIX: sebelumnya cuma job type 'deploy_nextjs' (attempt PERTAMA) yang
  // boleh di-retry. Kalau RETRY-nya sendiri gagal lagi (job hasil retry
  // bertipe 'deploy_nextjs_retry'), job itu gak bisa di-retry lagi lewat
  // endpoint ini - user kepentok gak bisa lanjutin/ubah .env lagi walau
  // stoppedAtKey-nya ada. Sekarang job hasil retry pun boleh jadi basis
  // retry berikutnya (retry rantai/berkali-kali).
  if (originalJob.type !== 'deploy_nextjs' && originalJob.type !== 'deploy_nextjs_retry') {
    return res.status(400).json({ success: false, message: 'Job ini bukan job deploy, gak bisa di-retry.', code: 'INVALID_JOB_TYPE' });
  }
  if (originalJob.status !== 'failed') {
    return res.status(400).json({ success: false, message: `Job ini statusnya "${originalJob.status}", cuma job "failed" yang bisa di-retry.`, code: 'JOB_NOT_FAILED' });
  }
  if (!originalJob.stoppedAtKey) {
    return res.status(400).json({
      success: false,
      message: 'Job ini gagal sebelum folder sempat di-clone (safety check/mkdir/git clone) - belum ada yang bisa dilanjutin. Deploy ulang dari awal lewat POST /deploy.',
      code: 'NOT_RESUMABLE',
    });
  }

  const { error, overrides } = validateRetryOverrides(req.body || {});
  if (error) {
    return res.status(400).json({ success: false, message: error, code: 'INVALID_INPUT' });
  }

  // Bug fix: sebelumnya SELALU resume persis dari originalJob.stoppedAtKey,
  // walau ada override yang harusnya bikin step LEBIH AWAL wajib diulang.
  // Skenario nyata yang dilaporkan: job gagal di step "build" (artinya step
  // "env" udah kepakai & sukses duluan dengan .env yang SALAH), lalu retry
  // dikirim dengan envContent baru - tanpa logic ini, retry tetap mulai dari
  // "build" (step "env" di-skip karena udah dianggap "sukses" di attempt
  // sebelumnya), jadi .env yang salah TETAP kepakai walau overridenya sudah
  // dikirim benar.
  const forcedEarliestKeys = [];
  if (overrides.envContent !== undefined) forcedEarliestKeys.push('env');
  // FIX: kalau prismaMode diubah pas retry, key step Prisma berubah nama
  // (mis. 'prisma_push' -> 'prisma_push_force') - tanpa dipaksa resume
  // lebih awal, dua skenario buruk kejadian: (1) job gagal PAS di step
  // prisma -> key lama gak ketemu di steps baru -> fallback restart dari
  // index 0, atau (2) job gagal di step SETELAH prisma (mis. build) ->
  // resume tetap mulai dari situ -> step prisma dengan mode BARU gak
  // pernah dijalankan sama sekali, diam-diam, tanpa error.
  // Dipaksa ke 'install' (BUKAN 'prisma' - itu bukan key asli, cuma nama
  // di RESUME_STEP_ORDER buat keperluan ranking; key ASLI-nya selalu
  // 'prisma_<mode>', jadi findIndex() di deployNew.js gak akan pernah
  // match kalau dipaksa ke literal 'prisma'). 'install' key asli yang
  // urutannya persis sebelum prisma di RESUME_STEP_ORDER, jadi resume
  // dari situ otomatis nyertain step prisma yang baru tanpa perlu ulang
  // step 'env' (kalau envContent-nya sendiri gak diubah).
  if (overrides.prismaMode !== undefined) forcedEarliestKeys.push('install');
  if (overrides.port !== undefined) forcedEarliestKeys.push('pm2_start');
  if (overrides.domain !== undefined) forcedEarliestKeys.push('nginx');
  const effectiveResumeFromKey = forcedEarliestKeys.reduce(
    (earliest, key) => (stepRank(key) < stepRank(earliest) ? key : earliest),
    originalJob.stoppedAtKey
  );

  // Kalau yang di-retry adalah job hasil retry sebelumnya (rantai retry),
  // `rootJobId` tetap nunjuk ke job 'deploy_nextjs' PALING AWAL (bukan job
  // retry perantara), supaya history/audit tetap bisa ditelusuri balik ke
  // attempt original walau sudah retry berkali-kali.
  const rootJobId = originalJob.params.originalJobId || originalJob.id;

  const startedAt = Date.now();
  const auditId = audit.recordStart({
    action: RETRY_ACTION,
    ip: req.ip,
    params: { originalJobId: rootJobId, resumeFromKey: effectiveResumeFromKey, overrides },
  });
  const jobId = jobStore.createJob('deploy_nextjs_retry', {
    ...originalJob.params,
    ...overrides,
    resumeFromKey: effectiveResumeFromKey,
    originalJobId: rootJobId,
  });

  const child = fork(RETRY_WORKER_PATH, [jobId], { detached: true, stdio: 'ignore' });
  child.unref();

  const overrideNote = Object.keys(overrides).length > 0 ? ` (dengan ${Object.keys(overrides).join(', ')} diubah)` : '';
  audit.recordEnd(auditId, { success: true, message: `Retry job ${jobId} dibuat dari job ${originalJob.id}, resume dari step "${effectiveResumeFromKey}"${overrideNote}.`, durationMs: Date.now() - startedAt });

  res.status(202).json({
    success: true,
    message: `Retry dimulai di background, resume dari step "${effectiveResumeFromKey}"${overrideNote}. Cek progress lewat GET /jobs/:id.`,
    data: { jobId },
  });
});

// Ditempel ke router (bukan ganti export) - Express tetap pakai router-nya
// seperti biasa, ini cuma biar validateBody() bisa dites otomatis tanpa
// perlu jalanin server beneran (lihat scripts/test-fixes.js).
module.exports.validateBody = validateBody;
module.exports.validateRetryOverrides = validateRetryOverrides;
module.exports.VALID_PRISMA_MODES = VALID_PRISMA_MODES;
