const fs = require('fs');
const path = require('path');
const { atomicWriteJSON, withFileLock } = require('../utils/safeFile');
const shell = require('../utils/shell');
const config = require('../config/config');

const REGISTRY_PATH = path.join(__dirname, '..', '..', 'data', 'registry.json');
const LOCK_PATH = `${REGISTRY_PATH}.lock`;

function ensureRegistryFile() {
  const dir = path.dirname(REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(REGISTRY_PATH)) {
    atomicWriteJSON(REGISTRY_PATH, { projects: [] });
  }
}

function loadRegistry() {
  ensureRegistryFile();
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  return JSON.parse(raw);
}

function saveRegistry(registry) {
  ensureRegistryFile();
  atomicWriteJSON(REGISTRY_PATH, registry);
}

function listProjects() {
  return loadRegistry().projects;
}

function findProject(name) {
  return listProjects().find((p) => p.name.toLowerCase() === name.toLowerCase());
}

function findByPort(port) {
  return listProjects().find((p) => p.port === port);
}

function findByDomain(domain) {
  return listProjects().find((p) => p.domain === domain);
}

/**
 * Tambah project baru ke registry. Menolak jika nama/port/domain sudah dipakai
 * (mencegah "salah folder", "bentrok port", "SSL salah" sesuai prinsip Safety System).
 *
 * DIBUNGKUS LOCK (withFileLock): sejak ada deploy async lewat API (tiap deploy
 * = proses fork() terpisah), dua deploy job bisa selesai hampir bersamaan dan
 * baca-ubah-tulis registry.json BARENGAN - tanpa lock, yang save belakangan
 * bisa nimpa perubahan yang save duluan (satu project "hilang" dari registry
 * walau folder/PM2/nginx-nya beneran ada). Lock ini bikin operasi tulis
 * registry jadi giliran, bukan bareng-bareng.
 */
function addProject(project) {
  return withFileLock(LOCK_PATH, () => {
    const registry = loadRegistry();

    if (registry.projects.some((p) => p.name.toLowerCase() === project.name.toLowerCase())) {
      throw new Error(`Project dengan nama "${project.name}" sudah terdaftar.`);
    }
    if (project.port && registry.projects.some((p) => p.port === project.port)) {
      throw new Error(`Port ${project.port} sudah dipakai project lain.`);
    }
    if (project.domain && registry.projects.some((p) => p.domain === project.domain)) {
      throw new Error(`Domain "${project.domain}" sudah terdaftar di project lain.`);
    }

    registry.projects.push(project);
    saveRegistry(registry);
    return project;
  });
}

function updateProject(name, updates) {
  return withFileLock(LOCK_PATH, () => {
    const registry = loadRegistry();
    const idx = registry.projects.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (idx === -1) throw new Error(`Project "${name}" tidak ditemukan.`);
    registry.projects[idx] = { ...registry.projects[idx], ...updates };
    saveRegistry(registry);
    return registry.projects[idx];
  });
}

/**
 * Cek apakah sebuah project di registry MASIH benar-benar aktif di server,
 * atau cuma catatan basi (project sudah dihapus manual di luar tool ini -
 * PM2 di-delete manual, folder dihapus manual, site nginx dicopot manual -
 * tapi registry.json nggak pernah diberitahu, karena belum ada fitur
 * "Delete Project" yang resmi).
 *
 * DIPAKAI oleh safety.js checkPort()/checkDomain() supaya Safety Check nggak
 * salah blokir deploy ulang gara-gara mikir port/domain masih "dipakai"
 * project yang sebenernya udah mati total.
 *
 * PRINSIP FAIL-SAFE: kalau salah satu sinyal GAGAL DICEK (bukan "dicek dan
 * ternyata nggak ada", tapi command-nya sendiri error/nggak bisa jalan -
 * misal shell nggak punya akses, atau parsing PM2 gagal), dianggap "unknown",
 * BUKAN langsung dianggap mati. Project hanya dianggap benar-benar mati kalau
 * SEMUA sinyal yang bisa dicek (folder, PM2, nginx) POSITIF menunjukkan sudah
 * nggak ada - biar nggak salah prune data yang sebenarnya masih valid.
 */
function isProjectAlive(project) {
  const folderExists = !!(project.path && fs.existsSync(project.path));

  // Cek PM2: app dengan nama ini ada di daftar `pm2 jlist` punya deploy_user
  // project ini? 'unknown' kalau command gagal/output nggak bisa diparse -
  // JANGAN diasumsikan 'absent' cuma gara-gara gagal cek.
  let pm2Status = 'unknown';
  const owner = project.deploy_user || config.loadConfig().deploy_user;
  if (project.name && owner) {
    const result = shell.runAsUser(owner, 'pm2 jlist', { silent: true });
    if (result.ok) {
      try {
        const start = result.output.indexOf('[');
        const end = result.output.lastIndexOf(']');
        if (start !== -1 && end !== -1 && end > start) {
          const apps = JSON.parse(result.output.slice(start, end + 1));
          pm2Status = apps.some((a) => a.name === project.name) ? 'present' : 'absent';
        }
      } catch (err) {
        pm2Status = 'unknown';
      }
    }
  }

  // Cek nginx: file conf domain ini masih ada? Pakai "&& echo ... || echo ..."
  // biar exit code SELALU 0 (nggak ketuker sama error sudo/permission lain),
  // hasil dibaca dari output-nya, bukan dari ok/gagalnya command.
  let nginxStatus = 'unknown';
  if (project.domain) {
    const cfg = config.loadConfig();
    const confPath = `${cfg.nginx_conf_dir}/${project.domain}.conf`;
    const result = shell.run(`sudo test -f "${confPath}" && echo EXISTS || echo MISSING`, { silent: true });
    if (result.ok) {
      const out = result.output.trim();
      if (out === 'EXISTS') nginxStatus = 'present';
      else if (out === 'MISSING') nginxStatus = 'absent';
    }
  }

  const definitelyDead =
    folderExists === false &&
    pm2Status === 'absent' &&
    (nginxStatus === 'absent' || !project.domain);

  return { alive: !definitelyDead, folderExists, pm2Status, nginxStatus };
}

function removeProject(name) {
  return withFileLock(LOCK_PATH, () => {
    const registry = loadRegistry();
    const before = registry.projects.length;
    registry.projects = registry.projects.filter(
      (p) => p.name.toLowerCase() !== name.toLowerCase()
    );
    if (registry.projects.length === before) {
      throw new Error(`Project "${name}" tidak ditemukan.`);
    }
    saveRegistry(registry);
  });
}

module.exports = {
  loadRegistry,
  saveRegistry,
  listProjects,
  findProject,
  findByPort,
  findByDomain,
  addProject,
  updateProject,
  removeProject,
  isProjectAlive,
};
