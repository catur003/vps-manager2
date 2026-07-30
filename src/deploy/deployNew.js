const shell = require('../utils/shell');
const safety = require('../safety/safety');
const nginx = require('../nginx/nginx');
const registry = require('../registry/registry');
const dbRegistry = require('../registry/dbRegistry');
const cleanup = require('../cleanup/cleanup');
const logger = require('../utils/logger');
const env = require('../project/env');

/**
 * Ambil nama database dari DATABASE_URL di isi .env (dipakai buat auto-link
 * database ke project - lihat catatan di step 'registry' buildFinishSteps()).
 * Balikin null kalau gak ketemu/gak match, TIDAK PERNAH throw.
 */
function extractDbNameFromEnv(envContent) {
  if (!envContent) return null;
  const lineMatch = envContent.match(/^\s*DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m);
  if (!lineMatch) return null;
  const pathMatch = lineMatch[1].trim().match(/\/([a-zA-Z0-9_]+)(?:\?.*)?$/);
  return pathMatch ? pathMatch[1] : null;
}

/**
 * Deploy project Next.js baru dari nol.
 * Berhenti di step manapun kalau gagal, dan HANYA mendaftarkan ke registry
 * kalau seluruh alur sukses sampai akhir. Folder yang sudah di-clone TIDAK
 * dihapus otomatis kalau gagal di step lanjutan (install/build/dll), supaya
 * bisa dicek/diperbaiki manual tanpa harus ulang clone dari nol.
 *
 * @param {object} opts
 * @param {string} opts.name        - nama unik project
 * @param {string} opts.gitRepo     - URL repo git
 * @param {string} opts.branch      - branch yang di-clone
 * @param {string} opts.domain      - domain untuk nginx
 * @param {number} opts.port        - port aplikasi
 * @param {string} opts.folderPath  - path folder tujuan clone
 * @param {string} opts.deployUser  - user pemilik project (mis. www)
 * @param {string} [opts.prismaMode] - 'none' | 'generate' | 'push' | 'push_force' | 'migrate'
 * @param {function} onStep         - callback(stepName, ok, message) dipanggil tiap step selesai
 */
/**
 * Tahap 1: safety check, siapkan folder, git clone. Berhenti duluan supaya
 * caller (menu) bisa baca file di dalam repo (misal .env.example) SEBELUM
 * lanjut ke instalasi/build - karena env content butuh isi repo yang baru
 * di-clone, bukan template statis.
 */
function prepareAndClone(opts, onStep = () => {}) {
  const { folderPath, port, domain, branch, gitRepo, deployUser } = opts;
  const steps = [];
  function report(stepName, ok, message) {
    steps.push({ step: stepName, ok, message });
    onStep(stepName, ok, message);
  }

  const safetyResult = safety.preDeployCheck({ folder: folderPath, port, domain });
  const safetySummary = safetyResult.checks.map((c) => `${c.name}: ${c.message}`).join(' | ');
  if (!safetyResult.allPass) {
    report('Safety Check', false, safetySummary);
    return { ok: false, stoppedAt: 'Safety Check', steps };
  }
  report('Safety Check', true, safetySummary);

  // Folder dibuat sebagai root, lalu di-chown ke deploy_user, supaya git clone
  // (yang jalan sebagai deploy_user) punya izin tulis di situ. Ini WAJIB walau
  // folder induk (/www/wwwroot) sudah ada, karena permission menulis di folder
  // induk belum tentu dimiliki deploy_user.
  //
  // Dipanggil pakai shell.runArgs()/runAsUserArgs() (execFileSync, TANPA
  // shell) - bukan shell.run()/runAsUser() yang lama - karena folderPath,
  // deployUser, branch, gitRepo/cloneUrl semuanya bisa datang dari body
  // POST /deploy yang formatnya belum tentu ketat divalidasi di semua
  // layer. Lewat execFileSync, tiap argumen dikirim sebagai argv terpisah,
  // jadi metachar shell (`$()`, `;`, spasi tak terduga, dst) di dalamnya
  // TIDAK PERNAH bisa memicu command tambahan, walau validasi di
  // deploy.routes.js suatu saat kurang ketat/ke-bypass.
  const mkdirResult = shell.runArgs('sudo', ['mkdir', '-p', folderPath]);
  if (!mkdirResult.ok) {
    report('Siapkan Folder', false, mkdirResult.errorMessage);
    return { ok: false, stoppedAt: 'Siapkan Folder', steps };
  }
  const chownResult = shell.runArgs('sudo', ['chown', '-R', `${deployUser}:${deployUser}`, folderPath]);
  if (!chownResult.ok) {
    report('Siapkan Folder', false, chownResult.errorMessage);
    return { ok: false, stoppedAt: 'Siapkan Folder', steps };
  }
  report('Siapkan Folder', true, `Folder "${folderPath}" siap dengan owner ${deployUser}.`);

  logger.info('⏳ Cloning repo, mohon tunggu...');
  // cloneUrl (kalau ada) = URL dengan username:token GitHub udah disisipkan,
  // dipakai KHUSUS buat command clone ini. `gitRepo` yang bersih (tanpa token)
  // tetap yang disimpan ke registry & ditampilkan ke layar - lihat catatan di
  // src/git/git.js buildAuthenticatedUrl()/stripCredentials().
  const cloneUrl = opts.cloneUrl || gitRepo;
  const cloneResult = shell.runAsUserArgs(deployUser, 'git', ['clone', '-b', branch, cloneUrl, folderPath], {
    timeoutMs: 5 * 60 * 1000, // 5 menit
  });
  if (!cloneResult.ok) {
    // FIX: sebelumnya folder yang barusan dibuat (mkdir+chown di atas)
    // dibiarkan nyangkut kalau clone gagal - deploy ulang berikutnya jadi
    // langsung mental di "Safety Check" ("Folder sudah ada"), padahal
    // folder itu masih kosong (belum pernah ke-clone apa pun ke situ).
    // Aman dihapus di sini karena baru saja KITA yang bikin folder ini di
    // step "Siapkan Folder" persis di atas - beda dengan kegagalan di step
    // SETELAH clone (install/build/dll) yang sengaja TIDAK di-rollback
    // karena folder itu sudah berisi source code asli yang mungkin masih
    // mau diperbaiki manual (lihat catatan di komentar function ini).
    const rollback = cleanup.deleteProjectFolder(deployUser, folderPath);
    const rollbackNote = rollback.ok
      ? ' Folder kosong yang sempat dibuat sudah otomatis dibersihkan - bisa langsung deploy ulang tanpa hapus folder manual.'
      : ` Folder kosong yang sempat dibuat GAGAL dibersihkan otomatis (${rollback.errorMessage}) - mungkin masih perlu dihapus manual sebelum deploy ulang.`;
    report('Git Clone', false, `${cloneResult.errorMessage}${rollbackNote}`);
    return { ok: false, stoppedAt: 'Git Clone', steps };
  }
  report('Git Clone', true, 'Repo berhasil di-clone.');

  return { ok: true, steps };
}

/**
 * Daftar step tahap 2, dalam bentuk array supaya bisa di-resume dari step
 * tertentu (dipakai fitur "Retry" pada recovery flow saat deploy gagal).
 * Setiap step punya `key` unik dan stabil supaya bisa dijadikan penanda
 * "stoppedAtKey" yang disimpan caller (menu) untuk retry nanti.
 */
function buildFinishSteps(opts) {
  const { name, domain, port, folderPath, deployUser, gitRepo, branch, prismaMode = 'none' } = opts;
  const steps = [];

  if (opts.envContent && opts.envContent.trim() !== '') {
    steps.push({
      key: 'env',
      label: 'Tulis .env',
      run: () => env.writeEnv(folderPath, deployUser, opts.envContent),
      successMessage: 'File .env berhasil dibuat.',
    });
  }

  steps.push({
    key: 'install',
    label: 'NPM Install',
    before: () => logger.info('⏳ Menjalankan npm install, ini bisa makan waktu 1-3 menit...'),
    run: () => shell.runAsUserArgs(deployUser, 'npm', ['install'], { cwd: folderPath, timeoutMs: 10 * 60 * 1000 }),
    successMessage: 'Dependencies terinstall.',
  });

  if (prismaMode && prismaMode !== 'none') {
    // Args (bukan string command) - dikirim ke runAsUserArgs (execFileSync,
    // tanpa shell), aman walau deployUser mengandung karakter aneh.
    const prismaArgs = {
      generate: ['--yes', 'prisma', 'generate'],
      push: ['--yes', 'prisma', 'db', 'push'],
      // 'migrate deploy' TIDAK punya flag --accept-data-loss (itu cuma
      // dipunyai 'db push') - migrate deploy apply migration file yang
      // udah di-commit, jadi gak perlu forced-confirm kayak db push.
      push_force: ['--yes', 'prisma', 'db', 'push', '--accept-data-loss'],
      migrate: ['--yes', 'prisma', 'migrate', 'deploy'],
    };
    const args = prismaArgs[prismaMode];
    if (args) {
      steps.push({
        key: `prisma_${prismaMode}`,
        label: `Prisma (${prismaMode})`,
        before: () => logger.info(`⏳ Menjalankan npx ${args.join(' ')}...`),
        run: () => shell.runAsUserArgs(deployUser, 'npx', args, { cwd: folderPath, timeoutMs: 3 * 60 * 1000 }),
        successMessage: 'Berhasil dijalankan.',
      });
    }
  }

  steps.push({
    key: 'build',
    label: 'Build',
    before: () => logger.info('⏳ Build project, ini bisa makan waktu 1-3 menit...'),
    run: () => shell.runAsUserArgs(deployUser, 'npm', ['run', 'build'], { cwd: folderPath, timeoutMs: 10 * 60 * 1000 }),
    successMessage: 'Build berhasil.',
  });

  steps.push({
    key: 'pm2_start',
    label: 'PM2 Start',
    run: () =>
      // --cwd DIWAJIBKAN eksplisit, jangan andelin PM2 "nebak" dari cwd shell
      // yang manggil. PM2 daemon persistent - kalau daemon-nya udah nyala
      // dari konteks lain sebelumnya (mis. dari proses vps-api sendiri),
      // cwd yang kecatet PM2 bisa ke-ambil dari konteks daemon itu, BUKAN
      // dari shell yang barusan manggil `pm2 start`, meski `cwd` udah bener
      // dikirim ke execSync. Ini nyebabin app hasil deploy salah jalan dari
      // folder vps-manager sendiri alih-alih folder project-nya.
      //
      // `PORT=${port}` di sini BUKAN interpolasi ke shell string - ini
      // argumen "VAR=value" yang di-parse langsung oleh `sudo` sendiri
      // (fitur bawaan sudo buat set env var proses target), dikirim lewat
      // execFileSync jadi masih 100% argv terpisah, bukan lewat shell.
      shell.runArgs(
        'sudo',
        ['-u', deployUser, `PORT=${port}`, 'pm2', 'start', 'npm', '--name', name, '--cwd', folderPath, '--', 'run', 'start'],
        { cwd: folderPath }
      ),
    successMessage: `App "${name}" berjalan di PM2 pada port ${port}.`,
  });

  steps.push({
    key: 'pm2_save',
    label: 'PM2 Save',
    run: () => shell.runAsUserArgs(deployUser, 'pm2', ['save']),
    successMessage: 'PM2 startup list disimpan.',
  });

  steps.push({
    key: 'nginx',
    label: 'Nginx Site',
    run: () => nginx.createReverseProxySite({ domain, port }),
    successMessage: `Site "${domain}" dibuat dan nginx sudah di-reload.`,
  });

  steps.push({
    key: 'registry',
    label: 'Registry',
    run: () => {
      try {
        registry.addProject({
          name,
          type: 'nextjs',
          domain,
          port,
          path: folderPath,
          deploy_user: deployUser,
          git_repo: gitRepo,
          git_branch: branch,
        });

        // FIX (Bug: "Drop Database" pas Hapus Project gak ngefek buat project
        // yang di-deploy lewat API/app): dbRegistry entry cuma dapet field
        // usedByProject kalau di-set lewat menu CLI (mainMenu.js) - endpoint
        // API create database (database.routes.js POST /) TIDAK PERNAH
        // nyimpen field ini. Akibatnya deleteProject.js gak nemu database
        // "terkait" project manapun yang dibuat lewat app, walau DB itu
        // beneran dipakai (connection string-nya ditempel manual ke .env
        // pas deploy). Di sini kita coba tebak otomatis: kalau DATABASE_URL
        // di isi .env cocok sama salah satu dbName di dbRegistry yang BELUM
        // ke-link ke project manapun, link-kan ke project ini. Best-effort
        // & TIDAK FATAL - gagal/gak ketemu match gak boleh gagalin deploy.
        try {
          const dbName = extractDbNameFromEnv(opts.envContent);
          if (dbName) {
            const entry = dbRegistry.findByName(dbName);
            if (entry && !entry.usedByProject) {
              dbRegistry.upsertEntry({ ...entry, usedByProject: name });
            }
          }
        } catch (linkErr) {
          logger.info(`(info) Auto-link database ke project dilewati: ${linkErr.message}`);
        }

        return { ok: true };
      } catch (err) {
        return { ok: false, errorMessage: err.message };
      }
    },
    successMessage: 'Project berhasil didaftarkan.',
  });

  return steps;
}

/**
 * Dipanggil KHUSUS saat retry (resumeFromKey diisi) - folder project sudah
 * ada dari attempt sebelumnya (hasil `prepareAndClone`), tapi ISINYA bisa
 * jadi source LAMA (commit di attempt pertama), padahal repo GitHub-nya
 * mungkin sudah di-push commit baru sejak itu (Bug #2: retry sebelumnya
 * build dari clone lama, bukan source asli terbaru).
 *
 * `git fetch` + `git reset --hard origin/<branch>` di folder yang SUDAH ADA
 * (bukan `rm -rf` + clone ulang) dipilih sengaja:
 * - Kredensial repo private (kalau ada) otomatis kepakai lagi dari remote
 *   "origin" yang sudah tersimpan di `.git/config` folder ini sejak clone
 *   pertama - TIDAK perlu opts.cloneUrl dikirim ulang lagi ke retry (yang
 *   memang TIDAK disimpan ke job.params buat request lewat API, lihat
 *   deploy.routes.js validateBody).
 * - `git reset --hard` cuma nyentuh file yang DILACAK git - file `.env`
 *   (biasanya di .gitignore, jadi untracked) TIDAK ikut kehapus/kereset.
 * - Nggak buang kerja `npm install` yang sudah sukses kalau ternyata source
 *   MEMANG belum berubah sejak attempt sebelumnya (lihat `sourceChanged`).
 */
function refreshSourceFromGit(opts) {
  const { folderPath, deployUser, branch } = opts;

  const beforeResult = shell.runAsUserArgs(deployUser, 'git', ['-C', folderPath, 'rev-parse', 'HEAD'], { silent: true });
  const beforeHead = beforeResult.ok ? beforeResult.output.trim() : null;

  const fetchResult = shell.runAsUserArgs(deployUser, 'git', ['-C', folderPath, 'fetch', 'origin', branch], {
    timeoutMs: 2 * 60 * 1000,
  });
  if (!fetchResult.ok) {
    return { ok: false, errorMessage: `Gagal "git fetch origin ${branch}": ${fetchResult.errorMessage}` };
  }

  const resetResult = shell.runAsUserArgs(deployUser, 'git', ['-C', folderPath, 'reset', '--hard', `origin/${branch}`]);
  if (!resetResult.ok) {
    return { ok: false, errorMessage: `Gagal "git reset --hard origin/${branch}": ${resetResult.errorMessage}` };
  }

  const afterResult = shell.runAsUserArgs(deployUser, 'git', ['-C', folderPath, 'rev-parse', 'HEAD'], { silent: true });
  const afterHead = afterResult.ok ? afterResult.output.trim() : null;

  return {
    ok: true,
    beforeHead: beforeHead || 'unknown',
    afterHead: afterHead || 'unknown',
    // Kalau salah satu rev-parse gagal (jarang - berarti ada masalah lain di
    // repo), JANGAN diam-diam anggap "tidak berubah". Default ke `true`
    // (anggap berubah) - konsekuensinya cuma install/build diulang sedikit
    // lebih boros, jauh lebih aman daripada salah nge-skip padahal berubah.
    sourceChanged: beforeHead && afterHead ? beforeHead !== afterHead : true,
  };
}

/**
 * Tahap 2: lanjutan setelah repo ter-clone dan .env final sudah diputuskan
 * oleh menu (lihat prepareAndClone). Tulis .env, install, prisma, build,
 * pm2, nginx, lalu daftar ke registry HANYA kalau semua sukses.
 *
 * @param {string|null} resumeFromKey - kalau diisi, step-step SEBELUM key ini
 *   dilewati (tidak dijalankan ulang) DAN source di-refresh dulu dari GitHub
 *   lewat refreshSourceFromGit() - lihat komentar di fungsi itu. Dipakai
 *   fitur "Retry": kalau deploy sebelumnya gagal di step X, retry cukup
 *   lanjut dari X (pakai source TERBARU dari GitHub, bukan source basi hasil
 *   clone attempt pertama).
 */
function finishDeploy(opts, onStep = () => {}, resumeFromKey = null) {
  const steps = buildFinishSteps(opts);
  const results = [];
  function report(stepName, ok, message) {
    results.push({ step: stepName, ok, message });
    onStep(stepName, ok, message);
  }

  let startIndex = 0;
  if (resumeFromKey) {
    const refresh = refreshSourceFromGit(opts);
    if (!refresh.ok) {
      report('Refresh Source (git fetch)', false, refresh.errorMessage);
      // stoppedAtKey SENGAJA dibalikin ke resumeFromKey semula (bukan key
      // baru) - kalau fetch gagal (mis. gangguan jaringan sesaat ke
      // GitHub), retry BERIKUTNYA tetap nyoba refresh+resume dari titik yang
      // sama lagi, bukan mundur atau restart total gara-gara satu percobaan
      // fetch yang gagal.
      return { ok: false, stoppedAt: 'Refresh Source (git fetch)', stoppedAtKey: resumeFromKey, steps: results };
    }
    report(
      'Refresh Source (git fetch)',
      true,
      refresh.sourceChanged
        ? `Source berubah sejak attempt sebelumnya (${refresh.beforeHead.slice(0, 7)} -> ${refresh.afterHead.slice(0, 7)}) - step install/prisma/build diulang dari awal biar konsisten dengan source terbaru.`
        : `Source sama persis dengan attempt sebelumnya (${refresh.afterHead.slice(0, 7)}) - lanjut resume dari step yang gagal, step yang sudah sukses tidak diulang.`
    );

    // Kalau source BERUBAH, JANGAN resume dari resumeFromKey lama - restart
    // dari step paling awal (index 0). Step yang sebelumnya sudah sukses
    // (install/prisma/build) itu ngerjain source LAMA - belum tentu masih
    // valid buat source BARU (mis. dependency baru ditambah di package.json,
    // schema Prisma berubah, dll). Kalau source TIDAK berubah, tetap resume
    // seperti biasa (hemat waktu, gak install/build ulang tanpa perlu).
    if (refresh.sourceChanged) {
      startIndex = 0;
    } else {
      const idx = steps.findIndex((s) => s.key === resumeFromKey);
      startIndex = idx >= 0 ? idx : 0;
    }
  }

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    if (step.before) step.before();
    const stepResult = step.run();
    if (!stepResult.ok) {
      report(step.label, false, stepResult.errorMessage);
      return { ok: false, stoppedAt: step.label, stoppedAtKey: step.key, steps: results };
    }
    report(step.label, true, step.successMessage || 'Berhasil.');
  }

  return { ok: true, steps: results };
}

/**
 * Versi gabungan (prepareAndClone + finishDeploy) buat kompatibilitas -
 * dipakai kalau caller sudah punya envContent final dari awal dan nggak
 * butuh baca isi repo di tengah proses.
 */
function deployNextJs(opts, onStep = () => {}) {
  const prep = prepareAndClone(opts, onStep);
  if (!prep.ok) return prep;
  const rest = finishDeploy(opts, onStep);
  return { ok: rest.ok, stoppedAt: rest.stoppedAt, stoppedAtKey: rest.stoppedAtKey, steps: [...prep.steps, ...rest.steps] };
}

module.exports = { deployNextJs, prepareAndClone, finishDeploy, refreshSourceFromGit };
