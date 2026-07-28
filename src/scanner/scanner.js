const http = require('http');
const fs = require('fs');

const security = require('../security/security');
const registry = require('../registry/registry');
const pm2 = require('../pm2/pm2');
const nginx = require('../nginx/nginx');
const { extractPortFromTarget } = require('../menu/helpers');

/**
 * VPS Scanner.
 *
 * Deteksi kondisi NYATA server (port, proses, respons API) dan bandingkan
 * dengan apa yang TERCATAT di registry.json - biar ketauan kalau ada
 * penyimpangan (app "online" di PM2 tapi port-nya nggak kebuka, port asing
 * yang nggak dikenal, domain nginx yang nunjuk ke port salah, dll).
 *
 * 4 tahap (sesuai flow):
 *  1. scanPm2Apps()   - Cari PM2 semua user
 *  2. scanPorts()     - Cek Port (real vs registry) + bedain sistem/app
 *  3. scanApiHealth() - Request tiap endpoint project, cek respons
 *  4. scanAll()       - Cocokkan semuanya ke Registry jadi 1 laporan utuh
 */

// Nama proses yang LAZIM adalah service sistem (bukan app project). Dipakai
// buat nge-label "Sistem" di port yang bukan urusan project sama sekali,
// biar operator nggak bingung/kepancing curiga sama port yang emang wajar
// (mis. nginx:80, mysqld:3306, sshd:22).
const SYSTEM_PROCESS_NAMES = new Set([
  'nginx', 'apache2', 'httpd', 'mysqld', 'mariadbd', 'postgres', 'postmaster',
  'sshd', 'systemd', 'systemd-resolve', 'systemd-timesyn', 'dockerd',
  'docker-proxy', 'containerd', 'redis-server', 'memcached', 'named', 'bind9',
  'crond', 'cron', 'rsyslogd', 'master', 'snapd', 'avahi-daemon', 'dnsmasq',
  'exim4', 'exim', 'php-fpm', 'php-fpm8.2', 'php-fpm8.1', 'php-fpm7.4',
]);

/**
 * Tentuin sebuah proses itu "Sistem", "App" (punya project di registry lewat
 * PM2), atau "Lainnya" (proses lain yang nggak dikenal) - SELALU balikin
 * label yang jelas, nggak pernah string kosong/undefined.
 */
function categorizeProcess(processName, pid, pm2PidMap) {
  if (!processName) {
    return { category: 'unknown', label: '❔ Tidak diketahui (perlu akses sudo untuk lihat nama proses)' };
  }

  if (pid && pm2PidMap.has(String(pid))) {
    const app = pm2PidMap.get(String(pid));
    return { category: 'app', label: `📦 App PM2: ${app.name} (user: ${app.owner})` };
  }

  const lower = processName.toLowerCase();
  if (lower === 'node' || lower === 'pm2' || lower.startsWith('node ')) {
    return { category: 'app', label: `📦 App Node (proses "${processName}", belum ke-mapping ke PM2 manapun)` };
  }
  if (SYSTEM_PROCESS_NAMES.has(lower)) {
    return { category: 'sistem', label: `⚙️  Sistem (${processName})` };
  }
  return { category: 'lainnya', label: `❓ Lainnya (${processName})` };
}

/**
 * Ambil semua app PM2 dari semua user relevan, dikelompokkan per owner biar
 * gampang dibaca (bukan 1 list panjang campur aduk).
 */
function scanPm2Apps() {
  const result = pm2.listApps();
  if (!result.ok && result.apps.length === 0) {
    return { ok: false, errorMessage: result.error || 'Gagal mengambil daftar PM2 dari semua user.' };
  }

  const grouped = {};
  result.apps.forEach((app) => {
    if (!grouped[app.owner]) grouped[app.owner] = [];
    grouped[app.owner].push(app);
  });

  return { ok: true, apps: result.apps, grouped, warnings: result.warnings || [] };
}

/**
 * Cek Port: port yang BENERAN kebuka di server vs port yang tercatat di
 * registry, plus kategorisasi Sistem/App/Lainnya biar informatif (bukan
 * cuma dump mentah `ss` yang susah dibaca dan gampang keliatan "kosong").
 */
function scanPorts() {
  const portResult = security.listOpenPorts();
  if (!portResult.ok) {
    return {
      ok: false,
      errorMessage: portResult.error || 'Gagal membaca daftar port terbuka (perlu akses sudo ke `ss`).',
    };
  }

  const pmResult = pm2.listApps();
  const pm2Apps = pmResult.ok ? pmResult.apps : [];
  const pm2PidMap = new Map(
    pm2Apps.filter((a) => a.pid && a.pid !== '-').map((a) => [String(a.pid), a])
  );

  const openPorts = portResult.ports.filter((p) => p.port && p.port !== '-');
  const openPortMap = new Map();
  openPorts.forEach((p) => {
    if (!openPortMap.has(p.port)) openPortMap.set(p.port, p);
  });

  const projects = registry.listProjects();

  const projectChecks = projects
    .filter((proj) => proj.port) // skip project tanpa port (mis. static site)
    .map((proj) => {
      const portStr = String(proj.port);
      const match = openPortMap.get(portStr);
      const categoryInfo = match
        ? categorizeProcess(match.processName, match.pid, pm2PidMap)
        : null;
      return {
        name: proj.name,
        port: proj.port,
        open: !!match,
        categoryLabel: categoryInfo ? categoryInfo.label : null,
      };
    });

  const knownPortStrings = new Set(projectChecks.map((c) => String(c.port)));
  const orphanPorts = openPorts
    .filter((p) => !knownPortStrings.has(p.port))
    .map((p) => {
      const categoryInfo = categorizeProcess(p.processName, p.pid, pm2PidMap);
      return {
        port: p.port,
        address: p.address,
        category: categoryInfo.category,
        label: categoryInfo.label,
      };
    });

  return { ok: true, projectChecks, orphanPorts };
}

/**
 * Request 1x ke sebuah port lokal (127.0.0.1) dan lihat responsnya.
 * Timeout pendek (3 detik) karena ini cuma health-check, bukan nunggu app
 * lambat - kalau app emang lambat/hang, itu justru info yang mau ditangkep.
 */
function checkApiEndpoint(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!port) {
      resolve({ reachable: false, status: null, note: 'Tidak ada port untuk dicek.' });
      return;
    }

    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      resolve({ reachable: true, status: res.statusCode, note: null });
      res.resume(); // buang body, kita cuma butuh status
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ reachable: false, status: null, note: 'Timeout - app nggak respon dalam 3 detik (bisa hang/overload).' });
    });

    req.on('error', (err) => {
      const note =
        err.code === 'ECONNREFUSED'
          ? 'Connection refused - port ini nggak ada yang listen.'
          : `Gagal konek: ${err.code || err.message}`;
      resolve({ reachable: false, status: null, note });
    });
  });
}

/**
 * Cek API semua project terdaftar yang punya port. Kalau port-nya sendiri
 * udah kedeteksi TIDAK terbuka (dari scanPorts), skip request HTTP-nya
 * (nggak ada gunanya nunggu timeout ke port yang jelas-jelas mati).
 */
async function scanApiHealth(projectChecks) {
  const results = [];
  for (const check of projectChecks) {
    if (!check.open) {
      results.push({ name: check.name, port: check.port, reachable: false, status: null, note: 'Port tidak terbuka, request dilewati.' });
      continue;
    }
    const apiResult = await checkApiEndpoint(check.port);
    results.push({ name: check.name, port: check.port, ...apiResult });
  }
  return results;
}

/**
 * Cocokkan Registry: untuk tiap project, apakah dia BENERAN ada (folder),
 * kepasang di PM2, port aslinya cocok dengan yang tercatat, dan domain
 * nginx-nya (kalau ada) beneran ngarah ke port yang benar.
 */
function matchRegistry(pm2Apps) {
  const projects = registry.listProjects();
  const nginxResult = nginx.listSites();
  const sites = nginxResult.ok ? nginxResult.sites : [];

  return projects.map((proj) => {
    const folderExists = !!(proj.path && fs.existsSync(proj.path));
    const pm2App = pm2Apps.find((a) => a.name === proj.name);
    const pm2Found = !!pm2App;
    const actualPort = pm2App && pm2App.port !== '-' ? pm2App.port : null;
    const portMatch = !proj.port ? null : actualPort !== null && String(actualPort) === String(proj.port);

    let domainMatch = null;
    if (proj.domain) {
      const site = sites.find((s) => s.domain && s.domain.split(' ').includes(proj.domain));
      if (!site) {
        domainMatch = false;
      } else {
        const targetPort = extractPortFromTarget(site.target);
        domainMatch = !!(targetPort && proj.port && String(targetPort) === String(proj.port));
      }
    }

    return {
      name: proj.name,
      folderExists,
      pm2Found,
      pm2Status: pm2App ? pm2App.status : null,
      portMatch, // null = project ini emang nggak pakai port, jadi n/a
      domainMatch, // null = project ini emang nggak punya domain, jadi n/a
    };
  });
}

/**
 * Full scan: jalanin ke-4 tahap dan gabung jadi 1 laporan. Ini yang dipakai
 * menu "Full Scan (Semua)".
 */
async function scanAll() {
  const pmResult = scanPm2Apps();
  const pm2Apps = pmResult.ok ? pmResult.apps : [];

  const portResult = scanPorts();
  if (!portResult.ok) {
    return { ok: false, errorMessage: portResult.errorMessage };
  }

  const apiResults = await scanApiHealth(portResult.projectChecks);
  const registryMatches = matchRegistry(pm2Apps);

  // App PM2 yang jalan tapi NAMANYA nggak ketemu di registry sama sekali -
  // kemungkinan di-deploy manual di luar tool ini atau app lama yang belum
  // dibersihkan.
  const registeredNames = new Set(registry.listProjects().map((p) => p.name));
  const orphanPm2Apps = pm2Apps.filter((a) => !registeredNames.has(a.name));

  return {
    ok: true,
    pm2: { apps: pm2Apps, warnings: pmResult.ok ? pmResult.warnings : [pmResult.errorMessage].filter(Boolean) },
    ports: portResult,
    api: apiResults,
    registryMatches,
    orphanPm2Apps,
  };
}

module.exports = {
  scanPm2Apps,
  scanPorts,
  checkApiEndpoint,
  scanApiHealth,
  matchRegistry,
  scanAll,
};
