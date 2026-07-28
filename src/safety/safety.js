const fs = require('fs');
const shell = require('../utils/shell');
const registry = require('../registry/registry');

/**
 * Cek apakah folder project sudah ada / bentrok.
 */
function checkFolder(targetPath) {
  const exists = fs.existsSync(targetPath);
  return {
    pass: !exists,
    message: exists
      ? `Folder "${targetPath}" sudah ada. Pastikan ini bukan project lain.`
      : `Folder "${targetPath}" aman digunakan.`,
  };
}

/**
 * Kalau registry bilang port/domain dipakai project X, tapi project X
 * ternyata SUDAH TIDAK AKTIF sama sekali (folder/PM2/nginx-nya semua sudah
 * nggak ada - lihat registry.isProjectAlive()), itu artinya entry-nya cuma
 * catatan basi (stale) - biasanya karena project pernah dihapus manual
 * langsung di server tanpa lewat tool ini. Auto-bersihin entry basi itu
 * dulu sebelum melapor konflik, supaya Safety Check nggak salah blokir
 * deploy ulang ke port/domain yang SEBENARNYA sudah kosong.
 *
 * Kalau gagal pastikan (ada sinyal 'unknown') ATAU project ternyata masih
 * benar-benar aktif, TETAP dianggap konflik seperti sebelumnya (fail-safe -
 * lebih baik salah blokir daripada salah kasih izin nabrak project lain).
 *
 * Return `null` kalau bukan stale (biarin caller lapor konflik seperti biasa),
 * atau pesan info kalau berhasil di-prune (biarin caller lolos).
 */
function reconcileStaleConflict(conflictProject) {
  const liveness = registry.isProjectAlive(conflictProject);
  if (liveness.alive) return null;

  try {
    registry.removeProject(conflictProject.name);
    return (
      `Port/domain tadinya tercatat dipakai project "${conflictProject.name}", ` +
      `tapi project itu sudah tidak aktif (folder/PM2/nginx-nya sudah tidak ada) - ` +
      `entry basi ini otomatis dibersihkan dari registry.`
    );
  } catch (err) {
    // Gagal prune (mis. race dengan proses lain) - jangan sampai safety check
    // ikut error, tetap lapor konflik seperti biasa (aman, sisi paling konservatif).
    return null;
  }
}

/**
 * Cek apakah port sudah dipakai oleh project lain di registry ATAU sedang listen di sistem.
 */
function checkPort(port) {
  const conflictInRegistry = registry.findByPort(port);
  if (conflictInRegistry) {
    const pruneMessage = reconcileStaleConflict(conflictInRegistry);
    if (pruneMessage) {
      return { pass: true, message: `${pruneMessage} Port ${port} sekarang tersedia.` };
    }
    return {
      pass: false,
      message: `Port ${port} sudah dipakai project "${conflictInRegistry.name}".`,
    };
  }

  const result = shell.run(`lsof -i :${port} -sTCP:LISTEN -t`, { silent: true });
  const isListening = result.ok && result.output.trim().length > 0;

  return {
    pass: !isListening,
    message: isListening
      ? `Port ${port} sedang dipakai proses lain di sistem.`
      : `Port ${port} tersedia.`,
  };
}

/**
 * Cek apakah domain sudah terdaftar di project lain.
 */
function checkDomain(domain) {
  const conflict = registry.findByDomain(domain);
  if (!conflict) {
    return { pass: true, message: `Domain "${domain}" aman digunakan.` };
  }

  const pruneMessage = reconcileStaleConflict(conflict);
  if (pruneMessage) {
    return { pass: true, message: `${pruneMessage} Domain "${domain}" sekarang tersedia.` };
  }

  return {
    pass: false,
    message: `Domain "${domain}" sudah dipakai project "${conflict.name}".`,
  };
}

/**
 * Cek sisa disk space (minimal 1GB free sebagai contoh threshold aman).
 */
function checkDisk(minFreeMB = 1024) {
  const result = shell.run(`df -m / | tail -1 | awk '{print $4}'`, { silent: true });
  const freeMB = parseInt(result.output, 10) || 0;
  return {
    pass: freeMB >= minFreeMB,
    message: `Disk tersisa ${freeMB} MB (minimal ${minFreeMB} MB).`,
  };
}

/**
 * Cek permission folder (owner harus sesuai deploy_user).
 */
function checkPermission(targetPath, deployUser) {
  if (!fs.existsSync(targetPath)) {
    return { pass: false, message: `Folder "${targetPath}" belum ada, tidak bisa dicek.` };
  }
  const result = shell.run(`stat -c '%U' "${targetPath}"`, { silent: true });
  const owner = result.output.trim();
  return {
    pass: owner === deployUser,
    message:
      owner === deployUser
        ? `Owner folder sudah benar (${owner}).`
        : `Owner folder saat ini "${owner}", seharusnya "${deployUser}".`,
  };
}

/**
 * Jalankan semua safety check sebelum deploy baru. Mengembalikan ringkasan
 * pass/fail per item, sesuai konsep "Safety System Otomatis".
 */
function preDeployCheck({ folder, port, domain }) {
  const checks = [
    { name: 'Folder', ...checkFolder(folder) },
    { name: 'Port', ...checkPort(port) },
    { name: 'Domain', ...checkDomain(domain) },
    { name: 'Disk', ...checkDisk() },
  ];
  const allPass = checks.every((c) => c.pass);
  return { allPass, checks };
}

/**
 * Cari port kosong pertama mulai dari basePort (cek registry + sistem).
 */
function findFreePort(basePort, maxTries = 100) {
  for (let port = basePort; port < basePort + maxTries; port++) {
    if (checkPort(port).pass) return port;
  }
  return null;
}

module.exports = {
  checkFolder,
  checkPort,
  checkDomain,
  checkDisk,
  checkPermission,
  preDeployCheck,
  findFreePort,
};
