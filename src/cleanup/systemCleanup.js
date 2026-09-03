const shell = require('../utils/shell');
const pm2 = require('../pm2/pm2');
const { formatBytes } = require('./cleanup');

/**
 * Beda dari cleanup.js (scan cache PER-USER/PER-PROJECT), modul ini nyakup
 * cache level SISTEM yang gak nempel ke 1 user/project tertentu - npm cache
 * global tiap user, APT package cache, Docker image/build cache reclaimable,
 * dan systemd journal log. Semua kategori di sini SELALU aman dibersihkan
 * (regenerable otomatis oleh tool masing-masing), gak perlu guard blacklist
 * serumit cleanup.js karena gak pernah nyentuh source code/data project.
 */

// PENTING: pakai runAsUser (bash -c, bukan runAsUserArgs) - sudoers cuma
// ngizinin catur jalanin `du` LANGSUNG buat RunAs dirinya sendiri (catur),
// SELAIN itu (mis. RunAs ubuntu) cuma `/bin/bash` bare yang diizinkan (lihat
// setup-sudoers.sh, rule "Terminal web"). `targetPath` di sini SELALU dari
// getent (path home user, bukan input eksternal), jadi aman diselipkan ke
// string command.
function duBytes(user, targetPath) {
  const result = shell.runAsUser(user, `du -sb "${targetPath}" 2>/dev/null`, { silent: true });
  if (!result.ok || !result.output) return 0;
  return parseInt(result.output.trim().split(/\s+/)[0], 10) || 0;
}

function scanNpmCache() {
  const users = pm2.getRelevantUsers();
  const perUser = [];
  let totalBytes = 0;
  for (const user of users) {
    const home = shell.runArgs('getent', ['passwd', user], { silent: true });
    if (!home.ok) continue;
    const homeDir = home.output.split(':')[5];
    if (!homeDir) continue;
    const bytes = duBytes(user, `${homeDir}/.npm`);
    if (bytes > 0) {
      perUser.push({ user, path: `${homeDir}/.npm`, bytes });
      totalBytes += bytes;
    }
  }
  return { bytes: totalBytes, perUser };
}

function scanAptCache() {
  // Folder ini readable tanpa sudo (cuma sub-folder "partial" di dalamnya
  // yang restricted, itu normal & diabaikan lewat stderr redirect) - gak
  // perlu lewat duBytes/user-switch sama sekali.
  // `du` bisa exit non-zero (subfolder "partial" permission denied) TAPI
  // tetap ngeprint total ke stdout SEBELUM exit - makanya cek `output`
  // langsung, bukan cuma `result.ok` (yang bakal false di kasus ini).
  const result = shell.run('du -sb /var/cache/apt/archives 2>/dev/null', { silent: true });
  const bytes = result.output ? parseInt(result.output.trim().split(/\s+/)[0], 10) || 0 : 0;
  return { bytes };
}

/**
 * `docker system df --format json` ngasih breakdown per tipe (Images,
 * Containers, Local Volumes, Build Cache) - kita ambil kolom "Reclaimable"
 * (bytes) tiap tipe, BUKAN "Size" total (yang termasuk yang masih dipakai
 * container aktif - gak boleh ikut dianggap "aman dibersihkan").
 */
function scanDockerReclaimable() {
  const result = shell.run('sudo docker system df --format "{{json .}}"', { silent: true });
  if (!result.ok || !result.output) return { bytes: 0, breakdown: [] };
  const breakdown = [];
  let totalBytes = 0;
  result.output.split('\n').filter(Boolean).forEach((line) => {
    try {
      const row = JSON.parse(line);
      // Format "Reclaimable" contoh: "1.884GB (34%)" - ambil angka+unit di depan spasi
      const match = (row.Reclaimable || '').match(/^([\d.]+)\s*([KMGT]?B)/);
      if (!match) return;
      const value = parseFloat(match[1]);
      const unit = match[2];
      const multiplier = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] || 1;
      const bytes = Math.round(value * multiplier);
      breakdown.push({ type: row.Type, bytes });
      totalBytes += bytes;
    } catch (err) {
      // baris gak ke-parse (format docker beda versi) - skip diam-diam
    }
  });
  return { bytes: totalBytes, breakdown };
}

function scanJournal() {
  const result = shell.run('sudo journalctl --disk-usage', { silent: true });
  if (!result.ok || !result.output) return { bytes: 0 };
  // Output asli: "Archived and active journals take up 156.3M in the file
  // system." - satuannya SATU HURUF ("M"/"G"), BEDA dari `du`/`docker` yang
  // pakai "MB"/"GB" - regex ini match dua-duanya ("B" di akhir opsional).
  const match = result.output.match(/([\d.]+)\s*([KMGT])B?/i);
  if (!match) return { bytes: 0 };
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit] || 1;
  return { bytes: Math.round(value * multiplier) };
}

function scanAll() {
  const npm = scanNpmCache();
  const apt = scanAptCache();
  const docker = scanDockerReclaimable();
  const journal = scanJournal();
  return {
    categories: [
      { key: 'npm_cache', label: 'NPM Cache (semua user)', bytes: npm.bytes, bytesLabel: formatBytes(npm.bytes), detail: npm.perUser },
      { key: 'apt_cache', label: 'APT Package Cache', bytes: apt.bytes, bytesLabel: formatBytes(apt.bytes) },
      { key: 'docker_prune', label: 'Docker Image & Build Cache', bytes: docker.bytes, bytesLabel: formatBytes(docker.bytes), detail: docker.breakdown },
      { key: 'journal', label: 'Systemd Journal Log', bytes: journal.bytes, bytesLabel: formatBytes(journal.bytes) },
    ],
    totalBytes: npm.bytes + apt.bytes + docker.bytes + journal.bytes,
  };
}

function cleanCategory(key) {
  switch (key) {
    case 'npm_cache': {
      const users = pm2.getRelevantUsers();
      const results = users.map((user) => ({ user, result: shell.runAsUser(user, 'npm cache clean --force', { silent: true }) }));
      const failed = results.filter((r) => !r.result.ok);
      return failed.length === 0
        ? { ok: true }
        : { ok: false, errorMessage: failed.map((f) => `${f.user}: ${f.result.errorMessage}`).join(' | ') };
    }
    case 'apt_cache':
      return shell.run('sudo apt-get clean', { silent: true });
    case 'docker_prune': {
      const imageResult = shell.run('sudo docker image prune -af', { silent: true });
      const builderResult = shell.run('sudo docker builder prune -af', { silent: true });
      return imageResult.ok && builderResult.ok
        ? { ok: true }
        : { ok: false, errorMessage: [imageResult.errorMessage, builderResult.errorMessage].filter(Boolean).join(' | ') };
    }
    case 'journal':
      return shell.run('sudo journalctl --vacuum-time=7d', { silent: true });
    default:
      return { ok: false, errorMessage: `Kategori "${key}" tidak dikenal.` };
  }
}

module.exports = { scanAll, cleanCategory };
