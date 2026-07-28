
const fs = require('fs');
const { spawnSync } = require('child_process');
const shell = require('../utils/shell');
const config = require('../config/config');

/**
 * Cek non-interaktif apakah proses ini (user yang jalanin vps-api) bisa
 * `sudo -u <targetUser>` TANPA password. Pakai `sudo -n` (non-interactive) -
 * kalau sudoers belum diset atau butuh password, `sudo -n` langsung gagal
 * (exit code != 0) dalam waktu singkat, TIDAK ngegantung nunggu input yang
 * gak akan pernah datang (beda dari `sudo` biasa yang bisa hang di sini).
 * Ini read-only (`true` doang) - aman dipanggil kapan saja, gak ngubah state.
 */
function checkSudoAccess(targetUser) {
  const result = spawnSync('sudo', ['-n', '-u', targetUser, 'true'], { encoding: 'utf-8' });

  if (result.status === 0) {
    return { ok: true };
  }

  const stderr = (result.stderr || '').trim();
  const needsPassword = /password is required|a password is required/i.test(stderr);

  return {
    ok: false,
    reason: needsPassword
      ? `sudo minta password buat jalan sebagai "${targetUser}" - berarti belum ada rule NOPASSWD yang cocok di sudoers untuk user ini.`
      : stderr || `Gagal sudo sebagai "${targetUser}" (exit code ${result.status}).`,
  };
}


/**
 * Cek apakah command root yang dipakai vps-manager bisa dijalankan
 * tanpa password lewat sudoers.
 *
 * Read-only:
 * - hanya menjalankan command dengan sudo -n
 * - tidak mengubah konfigurasi
 * - timeout agar tidak hang
 */
function checkSudoCommands() {
  const nginxBinary = config.loadConfig().nginx_binary || 'nginx';
  const nginxConfDir = config.loadConfig().nginx_conf_dir;

  const checks = [
    {
      name: 'scan-port',
      command: ['ss', '-tlnp'],
    },
    {
      name: 'pm2',
      command: ['pm2', 'list'],
    },
    {
      name: 'firewall',
      command: ['ufw', 'status'],
    },
    {
      // FIXED: sebelumnya hardcode 'nginx' - kalau nginx_binary di config.json
      // custom (mis. aaPanel "/www/server/nginx/sbin/nginx"), sudoers bisa
      // sudah izinkan binary yang salah (atau sebaliknya) dan doctor tetap
      // lapor "OK" padahal command asli yang dipakai app gagal.
      name: 'nginx-test',
      command: [nginxBinary, '-t'],
    },
  ];

  // FIXED: tambahin check buat command yang dipakai fitur "Site Nginx"
  // (src/nginx/nginx.js listSites/viewSite) - sebelumnya gak pernah dicek
  // sama sekali di doctor, jadi user baru tahu ini bermasalah pas buka
  // menu Site Nginx dan dapat error mentah "a terminal is required...".
  if (nginxConfDir) {
    checks.push({ name: 'nginx-list-sites', command: ['ls', nginxConfDir] });
  }

  return checks.map((item) => {
    const result = spawnSync(
      'sudo',
      ['-n', ...item.command],
      {
        encoding: 'utf-8',
        timeout: 5000,
      }
    );

    return {
      name: item.name,
      ok: result.status === 0,
      reason:
        result.status === 0
          ? null
          : (result.stderr || '').trim() ||
            `Command gagal dengan exit code ${result.status}`,
    };
  });
}


/**
 * Cek folder default_folder ada, dan siapa ownernya - buat deteksi mismatch
 * kayak "deploy_user di config = 'www', tapi folder aslinya punya 'ubuntu'".
 * Read-only (fs.statSync doang, gak nulis apapun).
 */
function checkDeployFolder(folderPath) {
  try {
    if (!fs.existsSync(folderPath)) {
      return { ok: false, reason: `Folder "${folderPath}" belum ada.` };
    }

    const stat = fs.statSync(folderPath);

    const ownerResult = spawnSync(
      'stat',
      ['-c', '%U', folderPath],
      { encoding: 'utf-8' }
    );

    const owner =
      ownerResult.status === 0
        ? ownerResult.stdout.trim()
        : null;

    return {
      ok: true,
      exists: true,
      owner,
      mode: stat.mode,
    };

  } catch (err) {
    return {
      ok: false,
      reason: err.message,
    };
  }
}


/**
 * Jalankan seluruh self-check sekaligus - dipakai endpoint
 * GET /doctor/permissions dan CLI "Cek Kesiapan Sistem". Semua langkah di
 * sini READ-ONLY, gak ada satupun yang mengubah state server.
 */
function checkPermissions() {
  const cfg = config.loadConfig();
  const deployUser = cfg.deploy_user;

  const sudoCheck = checkSudoAccess(deployUser);
  const folderCheck = checkDeployFolder(cfg.default_folder);
  const sudoCommands = checkSudoCommands();

  const requiredCommands = [
    'git',
    'nginx',
    'certbot',
    'pm2',
    'ss',
    'ufw',
  ];

  const commands = requiredCommands.map((cmd) => ({
    command: cmd,
    available: shell.commandExists(cmd),
  }));

  const ownerMismatch =
    folderCheck.ok &&
    folderCheck.owner &&
    folderCheck.owner !== deployUser;

  const issues = [];


  if (!sudoCheck.ok) {
    issues.push({
      code: 'SUDO_NOT_CONFIGURED',
      message: sudoCheck.reason,
      hint: `Jalankan: sudo bash scripts/setup-sudoers.sh (atau tambahkan rule NOPASSWD manual untuk user "${deployUser}").`,
    });
  }


  sudoCommands.forEach((check) => {
    if (!check.ok) {
      issues.push({
        code: 'SUDO_COMMAND_FAILED',
        command: check.name,
        message: check.reason,
        hint: 'Periksa /etc/sudoers.d/vps-manager.',
      });
    }
  });


  if (!folderCheck.ok) {
    issues.push({
      code: 'DEPLOY_FOLDER_MISSING',
      message: folderCheck.reason,
    });
  }


  if (ownerMismatch) {
    issues.push({
      code: 'DEPLOY_USER_MISMATCH',
      message: `Config "deploy_user" = "${deployUser}", tapi owner folder "${cfg.default_folder}" = "${folderCheck.owner}".`,
      hint: 'Samakan deploy_user di Configuration dengan owner folder deploy sebenarnya, atau chown folder-nya.',
    });
  }


  commands.forEach((c) => {
    if (!c.available) {
      issues.push({
        code: 'COMMAND_NOT_FOUND',
        message: `Command "${c.command}" tidak ditemukan di PATH.`,
      });
    }
  });


  return {
    ok: issues.length === 0,
    deployUser,
    defaultFolder: cfg.default_folder,
    sudo: sudoCheck,
    sudoCommands,
    folder: folderCheck,
    commands,
    issues,
  };
}


module.exports = {
  checkSudoAccess,
  checkSudoCommands,
  checkDeployFolder,
  checkPermissions,
};