const { spawn } = require('child_process');
const shell = require('../utils/shell');

/**
 * TIDAK dibatasi ke satu folder tertentu - user eksplisit minta akses ke
 * SELURUH filesystem (setelah dikasih tau tradeoff-nya: kalau API key bocor,
 * penyerang bisa baca/tulis/hapus apa aja lewat endpoint ini). Mitigasinya
 * bukan di sini, tapi di lapisan auth (src/api/middleware/auth.js -
 * rate-limit + lockout per-IP buat percobaan key gagal, ditambah rate limit
 * umum di server.js).
 *
 * Semua operasi lewat `sudo` (bukan fs langsung dari proses ini) - proses
 * API jalan sebagai satu user (`catur`), tapi file yang mau diakses bisa
 * dimiliki user manapun (root punya /etc, dll).
 */

function listDir(path) {
  const target = path || '/';
  const result = shell.runArgs('sudo', ['ls', '-la', '--time-style=+%Y-%m-%dT%H:%M:%S', target], { silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  const lines = result.output.split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    const [perms, , owner, group, size, mtime, ...nameParts] = parts;
    let name = nameParts.join(' ');
    if (name === '.' || name === '..') continue;
    let type = 'file';
    if (perms.startsWith('d')) type = 'dir';
    else if (perms.startsWith('l')) { type = 'symlink'; name = name.split(' -> ')[0]; }
    entries.push({ name, type, size: parseInt(size, 10) || 0, owner, group, perms, mtime });
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { ok: true, path: target, entries };
}

const MAX_READ_BYTES = 5 * 1024 * 1024;

function readFile(path) {
  const sizeCheck = shell.runArgs('sudo', ['stat', '-c', '%s', path], { silent: true });
  if (!sizeCheck.ok) return { ok: false, errorMessage: sizeCheck.errorMessage };
  const size = parseInt(sizeCheck.output, 10) || 0;
  if (size > MAX_READ_BYTES) {
    return { ok: false, errorMessage: `File terlalu besar buat dibuka di editor (${(size / 1024 / 1024).toFixed(1)}MB, maks 5MB). Gunakan download.` };
  }
  const result = shell.runArgs('sudo', ['cat', path], { silent: true, maxBuffer: MAX_READ_BYTES + 1024 });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true, content: result.output, size };
}

function writeFile(path, content) {
  const result = shell.runArgs('sudo', ['tee', path], { input: content, silent: true, maxBuffer: MAX_READ_BYTES + 1024 });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

function deleteEntry(path) {
  if (path === '/' || path === '') return { ok: false, errorMessage: 'Gak bisa hapus root filesystem.' };
  const result = shell.runArgs('sudo', ['rm', '-rf', path]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

function rename(oldPath, newPath) {
  const result = shell.runArgs('sudo', ['mv', oldPath, newPath]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

function mkdir(path) {
  const result = shell.runArgs('sudo', ['mkdir', '-p', path]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

const OWNER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_.-]*(:[a-zA-Z_][a-zA-Z0-9_.-]*)?$/;

/**
 * Ganti owner/group (`chown user[:group] path`). Divalidasi ketat (regex
 * nama user/group Linux) - nilai ini masuk sebagai 1 argv terpisah ke
 * execFileSync, TAPI tetap divalidasi biar gak bisa nyelipin flag aneh
 * (mis. "--reference=/etc/shadow") lewat parameter owner.
 */
function chown(path, owner) {
  if (!OWNER_REGEX.test(owner)) {
    return { ok: false, errorMessage: 'Format owner tidak valid. Gunakan "user" atau "user:group".' };
  }
  const result = shell.runArgs('sudo', ['chown', owner, path]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

/**
 * Real user/group Linux di server ini (UID >= 1000 = akun manusia biasa,
 * plus beberapa service user yang lazim jadi owner file web: root,
 * www-data) - dipakai isi dropdown "Owner" di modal Permission, GANTI
 * text-input manual yang gampang typo (user minta: "kayak aaPanel", yang
 * emang selalu dropdown, gak pernah suruh user ngetik nama user sendiri).
 */
function listSystemUsers() {
  const result = shell.runArgs('sudo', ['cat', '/etc/passwd'], { silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage, users: [] };

  // www-data SENGAJA selalu di-include walau shell-nya nologin - itu justru
  // owner file yang paling umum dibutuhkan buat file web (nginx/php-fpm
  // worker jalan sebagai user ini), beda kasusnya sama service account lain
  // (snapd-range-*, nobody, dst) yang emang gak relevan jadi FILE OWNER.
  const NOLOGIN_SHELLS = ['/usr/sbin/nologin', '/sbin/nologin', '/usr/bin/false', '/bin/false'];
  const ALWAYS_INCLUDE = ['root', 'www-data'];
  const users = result.output.split('\n').filter(Boolean).map((line) => {
    const parts = line.split(':');
    return { name: parts[0], uid: parseInt(parts[2], 10), shell: parts[6] };
  }).filter((u) => ALWAYS_INCLUDE.includes(u.name) || (u.uid >= 1000 && !NOLOGIN_SHELLS.includes(u.shell)));

  return { ok: true, users: users.map((u) => u.name) };
}

const MODE_REGEX = /^[0-7]{3,4}$/;

/**
 * Ganti permission (`chmod <mode> path`) - dipanggil dari checkbox grid
 * User/Group/Other x Read/Write/Execute di frontend, BUKAN user ngetik
 * angka oktal manual (walau backend-nya tetap terima format oktal standar,
 * validasi ketat di sini juga - defense-in-depth kalau ada yang manggil API
 * ini langsung tanpa lewat UI checkbox).
 */
function chmod(path, mode) {
  if (!MODE_REGEX.test(mode)) {
    return { ok: false, errorMessage: 'Format permission tidak valid. Harus 3-4 digit oktal (mis. "755", "644").' };
  }
  const result = shell.runArgs('sudo', ['chmod', mode, path]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

/**
 * Upload: multer menyimpan file sementara di disk, lalu file dipindahkan
 * lewat `sudo cp`. Isi file tidak ditampung penuh di RAM proses API.
 */
function uploadFile(destPath, tempPath) {
  const result = shell.runArgs('sudo', ['cp', '--', tempPath, destPath], { silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

/**
 * Download: baca file mentah (binary-safe) - beda dari readFile() yang
 * .toString() hasilnya (bisa korupsi binary) & dibatasi 5MB buat editor.
 */
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

function downloadFile(path) {
  const sizeCheck = shell.runArgs('sudo', ['stat', '-c', '%s', path], { silent: true });
  if (!sizeCheck.ok) return { ok: false, errorMessage: sizeCheck.errorMessage };
  const size = parseInt(sizeCheck.output, 10) || 0;
  if (size > MAX_DOWNLOAD_BYTES) {
    return { ok: false, errorMessage: `File terlalu besar buat didownload lewat panel (${(size / 1024 / 1024).toFixed(0)}MB, maks 500MB).` };
  }
  const child = spawn('sudo', ['cat', '--', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: true, child, stream: child.stdout, size };
}

module.exports = { listDir, readFile, writeFile, deleteEntry, rename, mkdir, chown, chmod, listSystemUsers, uploadFile, downloadFile };
