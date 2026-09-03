const shell = require('../utils/shell');
const config = require('../config/config');
const registry = require('../registry/registry');
const node = require('../node/node');

/**
 * Kalau project ini di-pin ke versi Node tertentu (`project.node_version`,
 * diset lewat POST /node/project/:name - lihat node.routes.js), balikin
 * prefix `PATH=".../bin:$PATH" ` buat ditempel di depan command PM2, biar
 * baik `npm` MAUPUN `node` yang di-resolve pas start pakai versi itu (bukan
 * cuma `--interpreter` pm2 yang cuma nunjuk binary node doang - kita start
 * lewat `npm run start`, jadi `npm`-nya juga harus versi yang sama).
 *
 * Kembalikan string kosong kalau gak di-pin (pakai default nvm/system biasa)
 * atau kalau versi itu ternyata sudah gak terinstall lagi (fail-safe: lebih
 * baik kepakai default daripada start-nya gagal total).
 */
function nodePathPrefix(project) {
  if (!project?.node_version) return '';
  const binDir = node.resolveBinDir(project.deploy_user, project.node_version);
  return binDir ? `PATH="${binDir}:$PATH" ` : '';
}

/**
 * Ambil daftar user unik yang perlu dicek PM2-nya.
 * Diambil dari field deploy_user tiap project di registry (bukan hardcode "www"),
 * DITAMBAH SELALU deploy_user default di Configuration - BUKAN cuma fallback
 * pas registry kosong.
 *
 * BUG FIX (laporan Zen: "vps-manager-api gak masuk daftar App yang jalan"):
 * proses PM2 vps-manager-api SENDIRI bukan "project" yang terdaftar di
 * registry (gak pernah lewat `addProject()`) - kalau user yang jalanin dia
 * (dari Configuration `deploy_user`) BEDA dari semua deploy_user project
 * yang KEBETULAN udah terdaftar, sebelumnya dia gak pernah ke-cek sama
 * sekali (fallback ke config CUMA aktif kalau registry KOSONG TOTAL,
 * bukan union). Sekarang config.deploy_user SELALU masuk daftar yang dicek,
 * apapun isi registry-nya.
 */
function getRelevantUsers() {
  const projects = registry.listProjects();
  const cfg = config.loadConfig();
  const users = new Set(projects.map((p) => p.deploy_user).filter(Boolean));
  users.add(cfg.deploy_user);
  (cfg.additional_pm2_users || []).forEach((u) => users.add(u));
  return [...users];
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
  const project = registry.findProject(name);
  const prefix = nodePathPrefix(project);

  const quickResult = shell.runAsUser(owner, `${prefix}pm2 start ${name}`);
  if (quickResult.ok) return quickResult;

  if (!project) {
    return {
      ...quickResult,
      errorMessage: `${quickResult.errorMessage}\n(App "${name}" juga tidak ditemukan di registry, jadi tidak bisa auto-start pertama kali. Perlu path & port project ini.)`,
    };
  }

  // --cwd eksplisit - lihat komentar di deployNew.js step 'pm2_start' soal
  // kenapa ini gak boleh diandelin dari cwd shell doang.
  const startCmd = `${prefix}PORT=${project.port} pm2 start npm --name "${name}" --cwd "${project.path}" -- run start`;
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

const MEMORY_LIMIT_REGEX = /^\d+[KMG]$/;

/**
 * Set/ubah batas RAM per-app (`pm2 restart --max-memory-restart`) - PM2
 * otomatis restart proses itu sendiri kalau kepakainya lewat batas ini.
 * WAJIB `pm2 save` setelahnya, kalau enggak, restart PM2 daemon (mis. VPS
 * reboot) bakal ilang settingan-nya dan balik ke "tanpa batas" lagi.
 */
function setMemoryLimit(name, owner, limit) {
  if (!MEMORY_LIMIT_REGEX.test(limit)) {
    return { ok: false, errorMessage: 'Format limit harus angka + satuan K/M/G (mis. "300M", "1G").' };
  }
  const restartResult = shell.runAsUser(owner, `pm2 restart ${name} --max-memory-restart ${limit} --update-env`);
  if (!restartResult.ok) return restartResult;
  shell.runAsUser(owner, 'pm2 save');
  return { ok: true };
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

// Kunci internal PM2 sendiri (bukan environment variable app) - dibuang dari
// hasil getEnv() biar yang tampil di dashboard cuma ENV asli punya app,
// bukan campur aduk sama metadata PM2 (bikin bingung/susah dibedain).
const PM2_INTERNAL_ENV_KEYS = new Set([
  'PM2_HOME', 'pm_id', 'name', 'namespace', 'version', 'pm_cwd', 'exec_mode',
  'node_args', 'pm_out_log_path', 'pm_err_log_path', 'pm_pid_path', 'exec_interpreter',
  'watch', 'autorestart', 'unstable_restarts', 'created_at', 'restart_time',
  'pm_uptime', 'status', 'axm_actions', 'axm_monitor', 'axm_options', 'axm_dynamic',
  'vizion_running', 'DISABLE_GENERATE_STARTUP_SCRIPT', 'kill_retry_time',
  'merge_logs', 'vizion', 'autostart', 'instance_var', 'pmx', 'automation', 'treekill',
  'username', 'windowsHide', 'pm_exec_path', 'km_link', 'PM2_USAGE', 'unique_id',
  'exit_code',
  // Environment shell/OS baku yang IKUT KEBAWA karena proses ini di-start
  // lewat `sudo -u <user>` dari dalam sesi shell API - bukan sesuatu yang
  // app-nya sendiri set/butuh, cuma noise kalau ditampilin campur sama
  // env var yang beneran relevan (PORT, DATABASE_URL, dst).
  'LANG', 'LC_ALL', 'LC_CTYPE', 'LS_COLORS', 'TERM', 'COLORTERM', 'PATH',
  'MAIL', 'LOGNAME', 'USER', 'HOME', 'SHELL', 'PWD', 'SHLVL', 'XDG_DATA_DIRS',
  'SUDO_COMMAND', 'SUDO_USER', 'SUDO_UID', 'SUDO_GID',
]);

/**
 * Environment variable yang BENERAN aktif di proses PM2 yang lagi jalan -
 * beda dari isi file `.env` (project/env.js readEnv()), yang cuma "apa yang
 * TERTULIS di file", belum tentu sama dengan apa yang kepakai kalau proses-
 * nya di-start dengan override manual (`PORT=xxx pm2 start ...`) atau file
 * `.env`-nya diedit SETELAH proses terakhir di-restart (baru kepakai abis
 * restart, bukan otomatis live-reload).
 */
function getEnv(name, owner) {
  const result = shell.runAsUser(owner, 'pm2 jlist', { silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  try {
    const start = result.output.indexOf('[');
    const end = result.output.lastIndexOf(']');
    const apps = JSON.parse(result.output.slice(start, end + 1));
    const app = apps.find((a) => a.name === name);
    if (!app) return { ok: false, errorMessage: `App "${name}" tidak ditemukan di PM2 (mungkin belum pernah di-start).` };
    const env = {};
    for (const [key, value] of Object.entries(app.pm2_env || {})) {
      if (PM2_INTERNAL_ENV_KEYS.has(key)) continue;
      if (key.startsWith('_') || key === 'env' || typeof value === 'object' || typeof value === 'function') continue;
      env[key] = value;
    }
    return { ok: true, env };
  } catch (err) {
    return { ok: false, errorMessage: `Gagal parse output pm2 jlist: ${err.message}` };
  }
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
  getEnv,
  setMemoryLimit,
  getRelevantUsers,
};