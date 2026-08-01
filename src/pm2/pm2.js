const shell = require('../utils/shell');
const config = require('../config/config');
const registry = require('../registry/registry');

/**
 * Ambil daftar user unik yang perlu dicek PM2-nya.
 * Diambil dari field deploy_user tiap project di registry (bukan hardcode "www"),
 * dengan fallback ke deploy_user default di Configuration kalau registry masih kosong.
 */
function getRelevantUsers() {
  const projects = registry.listProjects();
  if (projects.length === 0) return [config.loadConfig().deploy_user];
  const users = new Set(projects.map((p) => p.deploy_user).filter(Boolean));
  return users.size > 0 ? [...users] : [config.loadConfig().deploy_user];
}

/**
 * Cari port yang sedang di-listen oleh sebuah PID (fallback kalau PM2 env tidak simpan PORT).
 */
function getPortByPid(user, pid) {
  if (!pid) return null;
  const result = shell.runAsUser(
    user,
    `lsof -Pan -p ${pid} -i -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $9}'`,
    { silent: true }
  );
  if (!result.ok || !result.output) return null;
  const match = result.output.split('\n')[0].match(/:(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Ambil daftar semua app PM2 dari SEMUA user yang relevan (bukan cuma "www"),
 * karena tiap project bisa punya deploy_user berbeda-beda.
 * Tiap app ditandai field `owner` supaya aksi selanjutnya (start/stop/dll)
 * tau harus dijalankan sebagai user siapa.
 */
function listApps() {
  const users = getRelevantUsers();
  const allApps = [];
  const errors = [];

  for (const user of users) {
    const result = shell.runAsUser(user, 'pm2 jlist', { silent: true });
    if (!result.ok) {
      errors.push(`User "${user}": ${result.errorMessage}`);
      continue;
    }
    try {
      // PM2 kadang nyetak log noise ke stdout SEBELUM JSON array-nya,
      // misal "[PM2] Spawning PM2 daemon with pm2_home=..." saat user ini
      // baru pertama kali punya PM2 daemon sendiri (belum ada ~/.pm2).
      // Ambil cuma bagian dari '[' pertama sampai ']' terakhir biar aman.
      const start = result.output.indexOf('[');
      const end = result.output.lastIndexOf(']');
      if (start === -1 || end === -1 || end < start) {
        throw new Error('output tidak mengandung JSON array yang valid');
      }
      const jsonSlice = result.output.slice(start, end + 1);
      const apps = JSON.parse(jsonSlice).map((app) => ({
        name: app.name,
        owner: user,
        status: app.pm2_env.status,
        pid: app.pid,
        port: app.pm2_env.PORT || app.pm2_env.env_PORT || getPortByPid(user, app.pid) || '-',
        ram: app.monit ? `${(app.monit.memory / 1024 / 1024).toFixed(1)} MB` : '-',
        cpu: app.monit ? `${app.monit.cpu}%` : '-',
        uptime: app.pm2_env.pm_uptime ? new Date(app.pm2_env.pm_uptime).toLocaleString() : '-',
        cwd: app.pm2_env.pm_cwd || '-',
        // Jumlah restart sejak app ini pertama kali di-start (termasuk restart
        // otomatis karena crash, bukan cuma yang manual). Kalau angka ini
        // tinggi & terus naik antar refresh, itu tanda crash-loop.
        restartCount: app.pm2_env.restart_time ?? 0,
      }));
      allApps.push(...apps);
    } catch (err) {
      errors.push(`User "${user}": gagal parsing output PM2 (${err.message})`);
    }
  }

  if (allApps.length === 0 && errors.length > 0) {
    return { ok: false, apps: [], error: errors.join(' | ') };
  }
  return { ok: true, apps: allApps, warnings: errors };
}

/**
 * Start app. Kalau PM2 SUDAH kenal nama ini (pernah start/ada di dump),
 * `pm2 start <name>` cukup. Kalau BELUM PERNAH sama sekali (daemon baru,
 * misal abis reboot dan belum di-save), PM2 nggak punya proses dengan nama
 * itu untuk di-restart -> harus di-start pakai command lengkap (cwd + PORT).
 * Fallback ini otomatis pakai data dari registry (path, port) supaya user
 * nggak perlu jalanin command manual lagi.
 */
function start(name, owner) {
  const quickResult = shell.runAsUser(owner, `pm2 start ${name}`);
  if (quickResult.ok) return quickResult;

  const project = registry.findProject(name);
  if (!project) {
    return {
      ...quickResult,
      errorMessage: `${quickResult.errorMessage}\n(App "${name}" juga tidak ditemukan di registry, jadi tidak bisa auto-start pertama kali. Perlu path & port project ini.)`,
    };
  }

  // --cwd eksplisit - lihat komentar di deployNew.js step 'pm2_start' soal
  // kenapa ini gak boleh diandelin dari cwd shell doang.
  const startCmd = `PORT=${project.port} pm2 start npm --name "${name}" --cwd "${project.path}" -- run start`;
  const fullStartResult = shell.runAsUser(owner, startCmd, { cwd: project.path });
  if (!fullStartResult.ok) return fullStartResult;

  const saveResult = shell.runAsUser(owner, 'pm2 save');
  return saveResult.ok
    ? { ok: true, output: `App "${name}" berhasil di-start pertama kali di port ${project.port} dan tersimpan ke startup list.` }
    : { ok: true, output: `App "${name}" berhasil di-start di port ${project.port}, tapi "pm2 save" gagal: ${saveResult.errorMessage}` };
}

function stop(name, owner) {
  return shell.runAsUser(owner, `pm2 stop ${name}`);
}

function restart(name, owner) {
  return shell.runAsUser(owner, `pm2 restart ${name}`);
}

function deleteApp(name, owner) {
  return shell.runAsUser(owner, `pm2 delete ${name}`);
}

function logs(name, owner, lines = 50) {
  return shell.runAsUser(owner, `pm2 logs ${name} --lines ${lines} --nostream`, { silent: true });
}

function saveStartup(owner) {
  return shell.runAsUser(owner, 'pm2 save');
}

function detail(name, owner) {
  return shell.runAsUser(owner, `pm2 describe ${name}`, { silent: true });
}

/**
 * Sama seperti listApps(), tapi juga menyertakan project yang TERDAFTAR di
 * registry namun belum pernah muncul di PM2 sama sekali (belum pernah
 * di-start, jadi nggak ada di `pm2 jlist`). Tanpa ini, app yang belum pernah
 * nyala nggak akan pernah bisa dipilih di menu "Start" - padahal itu justru
 * kasus utama yang perlu di-start.
 */
function listAppsIncludingUnstarted() {
  const { ok, apps, error, warnings } = listApps();
  const known = new Set(apps.map((a) => a.name));
  const registryOnly = registry
    .listProjects()
    .filter((p) => !known.has(p.name))
    .map((p) => ({
      name: p.name,
      owner: p.deploy_user,
      status: 'never started',
      pid: '-',
      port: p.port || '-',
      ram: '-',
      cpu: '-',
      uptime: '-',
      cwd: p.path || '-',
      restartCount: 0,
    }));
  return { ok: ok || registryOnly.length > 0, apps: [...apps, ...registryOnly], error, warnings };
}

module.exports = {
  listApps,
  listAppsIncludingUnstarted,
  start,
  stop,
  restart,
  deleteApp,
  logs,
  saveStartup,
  detail,
  getRelevantUsers,
};