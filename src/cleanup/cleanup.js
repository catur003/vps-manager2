const shell = require('../utils/shell');

/**
 * Blacklist lapisan kedua - dicek di SETIAP fungsi yang nyentuh filesystem
 * (scan & delete), bukan cuma di UI. Kalau home folder user atau target hapus
 * match salah satu ini (persis atau sub-path-nya), langsung ditolak. Jaga-jaga
 * kalau ada user aneh (mis. home-nya "/" atau folder sistem kepencet gara-gara
 * salah ketik username).
 */
const BLACKLIST = ['/', '/etc', '/usr', '/bin', '/boot', '/var/lib/mysql'];

function isBlacklisted(targetPath) {
  const normalized = targetPath.replace(/\/+$/, '') || '/';
  return BLACKLIST.some((b) => normalized === b || normalized.startsWith(b === '/' ? '/___never___' : `${b}/`));
}

// Pola cache HOME-level yang AMAN dihapus (dipakai scanUserCache).
// `buildArgs(home)` balikin ARRAY argv predicate `find` (bukan string) -
// lihat catatan FIXED di findCacheItems() soal alasannya.
const HOME_PATTERNS = [
  { label: 'Next.js build cache (.next/cache)', buildArgs: () => ['-type', 'd', '-path', '*/.next/cache'] },
  { label: 'node_modules cache (.cache di node_modules)', buildArgs: () => ['-type', 'd', '-path', '*/node_modules/.cache'] },
  { label: 'npm cache global', buildArgs: (home) => ['-type', 'd', '-path', `${home}/.npm/_cacache`] },
  { label: 'yarn cache', buildArgs: (home) => ['-type', 'd', '-path', `${home}/.cache/yarn`] },
  { label: 'pnpm cache', buildArgs: (home) => ['-type', 'd', '(', '-path', `${home}/.cache/pnpm`, '-o', '-path', `${home}/.local/share/pnpm`, ')'] },
  { label: 'pip cache', buildArgs: (home) => ['-type', 'd', '-path', `${home}/.cache/pip`] },
];

// Pola cache PROJECT-level (dipakai scanProjectCaches, discan per-project
// dari path PM2 - lebih sempit & lebih cepat daripada scan seluruh home).
const PROJECT_PATTERNS = [
  { label: 'Next.js build cache (.next/cache)', buildArgs: () => ['-type', 'd', '-path', '*/.next/cache'] },
  { label: 'node_modules cache (.cache di node_modules)', buildArgs: () => ['-type', 'd', '-path', '*/node_modules/.cache'] },
];

const MIN_SIZE_BYTES = 1024 * 1024; // skip item < 1MB, nggak worth ditampilin

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * FIXED (Fase 5): sebelumnya `getent passwd ${username} | cut -d: -f6` lewat
 * shell (pipe + string interpolation) - `username` bisa datang dari request
 * API (endpoint cleanup per-user) tanpa format bebas divalidasi, celah
 * command injection sama pola dengan yang di-fix di git.js/backup.js. Sekarang
 * `getent` dipanggil lewat execFileSync (argv terpisah, TANPA shell/pipe) dan
 * kolom home di-parse manual di JS dari outputnya (format baku
 * `user:x:uid:gid:gecos:home:shell`).
 */
function getUserHome(username) {
  const result = shell.runArgs('getent', ['passwd', username], { silent: true });
  if (!result.ok || !result.output) return null;
  const fields = result.output.trim().split(':');
  const home = fields[5];
  return home || null;
}

/**
 * Cari folder yang match sebuah pola cache di dalam `basePath`, return item
 * { label, path, bytes } buat tiap yang ketemu (>= MIN_SIZE_BYTES). Dipakai
 * bareng oleh scanUserCache (basePath = $HOME) dan scanProjectCaches
 * (basePath = cwd project dari PM2) - `owner` dipakai buat jalanin
 * find/du sebagai user yang benar (biar nggak kena masalah permission).
 *
 * FIXED (Fase 5): sebelumnya `basePath`/`itemPath` disisipkan LANGSUNG ke
 * string command find/du lewat shell.runAsUser() (mis. `find "${basePath}" ...`)
 * - nama folder yang mengandung karakter shell (`"`, `$()`, dst, walau jarang,
 * tapi mungkin kalau attacker bisa bikin folder sembarang nama di server)
 * bisa memicu command injection. Sekarang find/du dipanggil lewat
 * shell.runAsUserArgs() (execFileSync, argv terpisah) - basePath/itemPath
 * dikirim sebagai argv literal, shell TIDAK PERNAH melihat/mem-parsing
 * gabungan stringnya.
 */
function findCacheItems(owner, basePath, patterns) {
  const items = [];
  for (const p of patterns) {
    // -xdev: jangan nyebrang filesystem lain. maxdepth dikira-kira cukup
    // buat struktur project biasa tanpa bikin scan kelamaan.
    const args = ['find', basePath, '-xdev', '-maxdepth', '8', ...p.buildArgs(basePath), '-prune', '-print'];
    const result = shell.runAsUserArgs(owner, args[0], args.slice(1), { silent: true });
    if (!result.ok || !result.output) continue;

    result.output.split('\n').filter(Boolean).forEach((itemPath) => {
      if (isBlacklisted(itemPath)) return;
      const sizeResult = shell.runAsUserArgs(owner, 'du', ['-sb', itemPath], { silent: true });
      // Output `du -sb`: "<bytes>\t<path>" - ambil token pertama.
      const bytes = sizeResult.ok ? parseInt(sizeResult.output.trim().split(/\s+/)[0], 10) || 0 : 0;
      if (bytes >= MIN_SIZE_BYTES) items.push({ label: p.label, path: itemPath, bytes });
    });
  }
  return items;
}

/**
 * Scan folder home sebuah user, cari cache/file regenerable yang aman dihapus.
 * TIDAK PERNAH scan dari "/" - selalu dibatasi ke $HOME user tsb, dan $HOME
 * itu sendiri dicek dulu terhadap blacklist sebelum find apapun dijalankan.
 */
function scanUserCache(username) {
  const home = getUserHome(username);
  if (!home) return { ok: false, errorMessage: `User "${username}" tidak ditemukan.` };
  if (isBlacklisted(home)) {
    return { ok: false, errorMessage: `Home folder user ini ("${home}") termasuk folder sistem - scan dibatalkan demi keamanan.` };
  }

  const items = findCacheItems(username, home, HOME_PATTERNS).map((item) => ({ ...item, owner: username, home, project: null }));

  // PM2 log files (per file, bukan folder - log aktif nggak apa-apa dihapus,
  // PM2 otomatis nulis lagi ke file baru).
  const pm2LogsDir = `${home}/.pm2/logs`;
  const pm2Result = shell.runAsUserArgs(username, 'find', [pm2LogsDir, '-maxdepth', '1', '-type', 'f', '-name', '*.log', '-printf', '%s %p\n'], { silent: true });
  if (pm2Result.ok && pm2Result.output) {
    pm2Result.output.split('\n').filter(Boolean).forEach((line) => {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) return;
      const bytes = parseInt(line.slice(0, spaceIdx), 10) || 0;
      const itemPath = line.slice(spaceIdx + 1);
      if (bytes >= MIN_SIZE_BYTES && !isBlacklisted(itemPath)) {
        items.push({ label: 'PM2 log', path: itemPath, bytes, owner: username, home, project: null });
      }
    });
  }

  return { ok: true, items };
}

/**
 * Scan cache langsung dari daftar app PM2 (path diambil dari `cwd`/`pm_cwd`
 * tiap app, BUKAN ditebak/diketik manual). App online maupun offline
 * dua-duanya ikut discan. Dedupe by cwd kalau ada >1 app PM2 share folder
 * yang sama, biar nggak discan dobel.
 */
function scanProjectCaches(apps) {
  const seenCwd = new Set();
  const items = [];
  for (const app of apps) {
    const cwd = app.cwd;
    const owner = app.owner;
    if (!cwd || cwd === '-' || !owner || seenCwd.has(cwd)) continue;
    seenCwd.add(cwd);
    if (isBlacklisted(cwd)) continue;
    const found = findCacheItems(owner, cwd, PROJECT_PATTERNS);
    found.forEach((item) => items.push({ ...item, owner, home: cwd, project: app.name }));
  }
  return items;
}

/**
 * Hapus 1 path. Guard ganda: harus di dalam `home` (batas aman yang dikirim
 * caller dari hasil scan - $HOME user atau cwd project, BUKAN diketik manual)
 * DAN lolos cek blacklist.
 *
 * FIXED (Fase 5): `rm -rf` sebelumnya dijalankan lewat shell.runAsUser()
 * dengan `targetPath` diselipkan ke string command - ini fungsi yang
 * PALING kritis karena bakal langsung dipanggil dari API dengan `targetPath`
 * dari body request. Sekarang pakai shell.runAsUserArgs() (execFileSync) -
 * `targetPath` dikirim sebagai argv literal ke `rm`, gak pernah lewat shell.
 */
function deletePath(owner, targetPath, home) {
  if (!targetPath.startsWith(`${home}/`)) {
    return { ok: false, errorMessage: 'Path di luar batas folder yang diizinkan - dibatalkan demi keamanan.' };
  }
  if (isBlacklisted(targetPath)) {
    return { ok: false, errorMessage: 'Path ini termasuk folder sistem - dibatalkan demi keamanan.' };
  }
  return shell.runAsUserArgs(owner, 'rm', ['-rf', targetPath], { silent: true });
}

/**
 * Hapus folder PROJECT ITU SENDIRI (bukan sub-folder cache di dalamnya kayak
 * deletePath() di atas) - dipakai fitur "Delete Project". Guard lebih ketat
 * karena ini menghapus seluruh source code project, bukan cuma cache
 * regenerable:
 * - Blacklist folder sistem (sama seperti deletePath).
 * - Path WAJIB absolute & minimal 3 segmen (mis. "/www/wwwroot/nama-project")
 *   - nolak path dangkal kayak "/www" atau "/home/user" yang kemungkinan
 *     besar bukan folder 1 project doang, biar nggak ke-rm -rf gara-gara
 *     folderPath project ke-isi salah/kependekan di registry.
 *
 * FIXED (Fase 5): sama seperti deletePath() - `rm -rf` pindah dari
 * shell.runAsUser() (string interpolation) ke shell.runAsUserArgs() (argv
 * terpisah).
 */
function deleteProjectFolder(owner, targetPath) {
  if (!targetPath || !targetPath.startsWith('/')) {
    return { ok: false, errorMessage: 'Path project tidak valid (bukan absolute path).' };
  }
  const normalized = targetPath.replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length < 3) {
    return {
      ok: false,
      errorMessage: `Path "${normalized}" kelihatan terlalu dangkal buat folder 1 project (cuma ${segments.length} level) - dibatalkan demi keamanan, hapus manual kalau memang ini yang dimaksud.`,
    };
  }
  if (isBlacklisted(normalized)) {
    return { ok: false, errorMessage: 'Path ini termasuk folder sistem - dibatalkan demi keamanan.' };
  }
  return shell.runAsUserArgs(owner, 'rm', ['-rf', normalized], { silent: true });
}

module.exports = { scanUserCache, scanProjectCaches, deletePath, deleteProjectFolder, formatBytes, isBlacklisted, getUserHome };
