const shell = require('../utils/shell');
const postgres = require('../database/postgres');
const { withFileLock } = require('../utils/safeFile');

const TOOLS_LOCK_PATH = '/tmp/vps-manager-tools.lock';

/**
 * Daftar tool yang BIASANYA dibutuhkan di VPS produksi. `pkg` dipakai
 * langsung sebagai argv ke `apt-get install -y <pkg>` - TIDAK PERNAH dari
 * request/user, cuma dari daftar tetap ini (whitelist di kode, bukan input),
 * jadi aman dari command injection walau sudoers-nya scoped per-command.
 */
const TOOLS = [
  // --- Web Server ---
  { key: 'nginx', name: 'Nginx', category: 'Web Server', checkBin: 'nginx', pkg: 'nginx' },
  { key: 'certbot', name: 'Certbot (Let\'s Encrypt)', category: 'Web Server', checkBin: 'certbot', pkg: 'certbot' },
  { key: 'certbot-nginx', name: 'Certbot Nginx Plugin', category: 'Web Server', checkBin: null, pkg: 'python3-certbot-nginx' },
  // --- Database ---
  // FIXED: `mysql` binary dari `mariadb-client-core` (dependency terpisah,
  // gak ikut kehapus pas uninstall `mysql-server`, dan ke-share juga sama
  // MariaDB - bikin entry ini SELALU keliatan "terinstall" walau
  // mysql-server aslinya gak pernah ke-install). `mysql-server` sendiri
  // biasanya meta/transitional package, checkBin:null (dpkg -s) akurat.
  { key: 'mysql', name: 'MySQL Server', category: 'Database', checkBin: null, pkg: 'mysql-server' },
  // Entry TERPISAH dari 'mysql' di atas - di Ubuntu, `mysql-server` bisa
  // resolve ke MariaDB (transitional package) ATAU MySQL asli tergantung
  // repo yang aktif pas install. VPS ini ternyata pakai MariaDB murni
  // (`mariadb-server`, bukan lewat nama paket `mysql-server` sama sekali),
  // jadi entry `mysql` di atas gak pernah bisa akurat ngedeteksi/uninstall
  // database yang beneran jalan di server ini - butuh entry sendiri.
  { key: 'mariadb', name: 'MariaDB Server', category: 'Database', checkBin: null, pkg: 'mariadb-server' },
  // FIXED (laporan user: "udah hapus redis tapi status tetep terinstall"):
  // `psql`/`checkBin` sebelumnya dari `postgresql-client-common` - package
  // TERPISAH dari `postgresql` (pkg yang beneran di-install/remove tombol
  // ini), gak ikut kehapus pas uninstall. `postgresql` sendiri cuma
  // meta-package tanpa binary sendiri, jadi checkBin:null (fallback ke
  // `dpkg -s postgresql`) yang akurat.
  { key: 'postgresql', name: 'PostgreSQL', category: 'Database', checkBin: null, pkg: 'postgresql' },
  // FIXED: sama kasusnya - `redis-cli` dari package `redis-tools` (dependency
  // terpisah, gak ikut kehapus). `redis-server` binary MILIK package
  // `redis-server` sendiri, akurat buat deteksi install/uninstall-nya.
  { key: 'redis', name: 'Redis', category: 'Database', checkBin: 'redis-server', pkg: 'redis-server' },
  { key: 'memcached', name: 'Memcached', category: 'Database', checkBin: 'memcached', pkg: 'memcached' },
  // --- Runtime & Build ---
  // FIXED: `docker` binary ke-share sama `docker-ce-cli` (varian resmi),
  // jadi entry ini SELALU keliatan "terinstall" walau yang beneran
  // keinstall itu Docker CE, bukan docker.io. checkBin:null (dpkg -s
  // docker.io) akurat ngebedain dua-duanya.
  { key: 'docker', name: 'Docker Engine (docker.io)', category: 'Runtime', checkBin: null, pkg: 'docker.io' },
  // Entry TERPISAH - Docker CE resmi (dari repo Docker sendiri, bukan repo
  // Ubuntu) DAN docker.io SAMA-SAMA nyediain binary `docker`, jadi entry
  // `docker` di atas gak bisa dipakai buat ngedeteksi/uninstall varian CE
  // secara akurat (checkBin ketemu walau yang keinstall CE, bukan docker.io -
  // dan `apt-get remove docker.io` gak ngefek apa-apa ke CE). VPS ini
  // ternyata pakai Docker CE, bukan docker.io - butuh entry sendiri.
  { key: 'docker-ce', name: 'Docker CE (resmi)', category: 'Runtime', checkBin: null, pkg: 'docker-ce' },
  // FIXED: `make` dari package `make` sendiri (dependency terpisah dari
  // `build-essential`, gak ikut kehapus). `build-essential` meta-package
  // tanpa binary sendiri, checkBin:null (dpkg -s) yang akurat.
  { key: 'build-essential', name: 'Build Essential (gcc/make)', category: 'Runtime', checkBin: null, pkg: 'build-essential' },
  { key: 'python3-pip', name: 'Python3 + pip', category: 'Runtime', checkBin: 'pip3', pkg: 'python3-pip' },
  { key: 'supervisor', name: 'Supervisor', category: 'Runtime', checkBin: 'supervisord', pkg: 'supervisor' },
  { key: 'ffmpeg', name: 'FFmpeg', category: 'Runtime', checkBin: 'ffmpeg', pkg: 'ffmpeg' },
  { key: 'imagemagick', name: 'ImageMagick', category: 'Runtime', checkBin: 'convert', pkg: 'imagemagick' },
  // --- Security ---
  { key: 'ufw', name: 'UFW Firewall', category: 'Security', checkBin: 'ufw', pkg: 'ufw' },
  { key: 'fail2ban', name: 'Fail2ban', category: 'Security', checkBin: 'fail2ban-client', pkg: 'fail2ban' },
  // --- Utility ---
  { key: 'git', name: 'Git', category: 'Utility', checkBin: 'git', pkg: 'git' },
  { key: 'unzip', name: 'Unzip', category: 'Utility', checkBin: 'unzip', pkg: 'unzip' },
  { key: 'zip', name: 'Zip', category: 'Utility', checkBin: 'zip', pkg: 'zip' },
  { key: 'htop', name: 'Htop', category: 'Utility', checkBin: 'htop', pkg: 'htop' },
  { key: 'curl', name: 'curl', category: 'Utility', checkBin: 'curl', pkg: 'curl' },
  { key: 'wget', name: 'wget', category: 'Utility', checkBin: 'wget', pkg: 'wget' },
  { key: 'rsync', name: 'rsync', category: 'Utility', checkBin: 'rsync', pkg: 'rsync' },
  { key: 'jq', name: 'jq', category: 'Utility', checkBin: 'jq', pkg: 'jq' },
  { key: 'tmux', name: 'tmux', category: 'Utility', checkBin: 'tmux', pkg: 'tmux' },
  { key: 'vim', name: 'vim', category: 'Utility', checkBin: 'vim', pkg: 'vim' },
];

function findTool(key) {
  return TOOLS.find((t) => t.key === key) || null;
}

/**
 * Engine database yang SALING CONFLICT di level apt: install satu berarti
 * apt DIAM-DIAM membuang yang satunya lagi. Dan karena /var/lib/mysql masih
 * berisi data file format engine lama (tidak kompatibel), engine barunya
 * gagal start - hasilnya persis laporan user: MariaDB dari setup-otomatis
 * sehat, klik "MySQL Server" di menu ini, lalu semua fitur database mati
 * dengan ERROR 2003 dan kredensial di config.json nyangkut ke database yang
 * sudah tidak ada. installTool() menolak kombinasi ini lebih awal dengan
 * pesan jelas, alih-alih membiarkan apt merusak instalasi yang sedang dipakai.
 */
const INSTALL_CONFLICTS = {
  mysql: { name: 'MariaDB Server', checkPkgs: ['mariadb-server'] },
  mariadb: { name: 'MySQL Server', checkPkgs: ['mysql-server-8.0', 'mysql-server'] },
  // Docker daemon dari Ubuntu dan Docker CE resmi tidak boleh dicampur.
  // docker-ce-cli ikut dicek karena apt dapat melepasnya saat memasang
  // docker.io, meskipun package daemon docker-ce tidak tercatat utuh.
  docker: { name: 'Docker CE', checkPkgs: ['docker-ce', 'docker-ce-cli'] },
  'docker-ce': { name: 'Docker Engine (docker.io)', checkPkgs: ['docker.io'] },
};

/**
 * Cek package BENERAN terinstall penuh (status "installed"), bukan cuma
 * sisa config (`dpkg -s` masih balikin sukses buat state "config-files"
 * setelah apt remove tanpa purge - false positive kalau cuma cek exit code).
 */
function isPkgInstalled(pkg) {
  const r = shell.runArgs('dpkg-query', ['-W', '-f=${db:Status-Status}', pkg], { silent: true });
  return r.ok && r.output.trim() === 'installed';
}

const SERVICE_PORTS = {
  nginx: [80, 443],
  mysql: [3306],
  mariadb: [3306],
  postgresql: [5432],
  redis: [6379],
  memcached: [11211],
};

function findOccupiedPorts(key) {
  const ports = SERVICE_PORTS[key] || [];
  if (ports.length === 0) return [];
  const result = shell.runArgs('sudo', ['ss', '-tlnp'], { silent: true });
  if (!result.ok) return [];
  return result.output.split('\n').filter((line) => {
    const columns = line.trim().split(/\s+/);
    const localAddress = columns[3] || '';
    return ports.some((port) => localAddress.endsWith(':' + port));
  }).map((line) => line.trim()).slice(0, 4);
}

function isAaPanelNginxActive() {
  const result = shell.runArgs('ps', ['-eo', 'args'], { silent: true });
  return result.ok && result.output.split('\n').some((line) => line.includes('/www/server/nginx/sbin/nginx'));
}

/**
 * Simulasi resolver apt adalah sumber kebenaran terakhir: paket bisa punya
 * konflik transitif yang tidak tercantum di daftar manual. Jangan jalankan
 * install nyata kalau resolver berencana melepas package apa pun.
 */
function findPlannedRemovals(pkg) {
  const result = shell.runArgs('apt-get', ['-s', 'install', '-y', pkg], {
    silent: true,
    timeoutMs: 60 * 1000,
  });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  const packages = result.output.split('\n')
    .map((line) => line.trim().match(/^Remv\s+([^\s]+)/))
    .filter(Boolean)
    .map((match) => match[1]);
  return { ok: true, packages: [...new Set(packages)] };
}

/**
 * Deteksi terinstall/tidaknya tiap tool via `which` (gak butuh sudo, cuma
 * baca PATH). Buat tool yang checkBin-nya null (plugin, bukan binary
 * mandiri), dicek via `dpkg -s <pkg>` sebagai gantinya.
 */
function getPackageVersion(pkg) {
  const result = shell.runArgs('dpkg-query', ['-W', '-f=${Version}', pkg], { silent: true });
  return result.ok && result.output ? result.output.trim() : null;
}

function detectTools() {
  return TOOLS.map((t) => {
    const installed = t.checkBin
      ? (() => { const result = shell.runArgs('which', [t.checkBin], { silent: true }); return result.ok && !!result.output; })()
      : isPkgInstalled(t.pkg);
    return {
      key: t.key,
      name: t.name,
      category: t.category,
      packageName: t.pkg,
      installed,
      version: installed ? getPackageVersion(t.pkg) : null,
    };
  });
}

/**
 * Install satu tool lewat `sudo apt-get install -y <pkg>`. `pkg` SELALU dari
 * TOOLS di atas (lookup by key), never dari body request langsung - jadi
 * sudoers bisa di-scope exact per paket (lihat setup-sudoers.sh) tanpa buka
 * celah "apt-get install -y <apa aja>".
 */
function installToolUnlocked(key) {
  const tool = findTool(key);
  if (!tool) return { ok: false, errorMessage: `Tool "${key}" tidak dikenal.` };

  // Jangan pasang daemon baru ke port yang sudah dipakai service/container
  // lain. Kalau package target sendiri sudah terpasang, apt install ulang
  // tetap boleh karena itu operasi idempotent.
  if (!isPkgInstalled(tool.pkg)) {
    const occupied = findOccupiedPorts(key);
    if (occupied.length > 0) {
      return {
        ok: false,
        errorMessage: `${tool.name} tidak jadi diinstall: port servicenya sudah dipakai. ` +
          `Stop/migrasikan service atau container yang bentrok dulu. Listener: ${occupied.join(' | ')}`,
      };
    }
  }

  // Guard konflik engine yang diketahui (database dan Docker).
  const conflict = INSTALL_CONFLICTS[key];
  if (conflict && conflict.checkPkgs.some(isPkgInstalled)) {
    return {
      ok: false,
      errorMessage:
        `${tool.name} TIDAK jadi diinstall: ${conflict.name} sedang terinstall & dipakai di server ini. ` +
        `Keduanya saling konflik di apt - install ${tool.name} akan MEMBUANG ${conflict.name} beserta akses database yang ada, ` +
        `dan engine barunya kemungkinan besar gagal start karena data lama tidak kompatibel. ` +
        `Kalau memang mau pindah engine: backup semua database dulu, uninstall ${conflict.name} dari menu ini, baru install ${tool.name}.`,
    };
  }

  const updateResult = shell.runArgs('sudo', ['apt-get', 'update'], { timeoutMs: 2 * 60 * 1000 });
  if (!updateResult.ok) {
    return { ok: false, errorMessage: `apt-get update gagal: ${updateResult.errorMessage}` };
  }

  // aaPanel menjalankan binary Nginx sendiri. Paket nginx Ubuntu tidak
  // otomatis menggantikannya, tapi keduanya akan berebut port 80/443 dan
  // operator bisa salah mengedit konfigurasi. Deteksi dari proses aktif,
  // bukan cuma folder aaPanel yang mungkin tinggal sisa.
  if (key === 'nginx' && !isPkgInstalled('nginx') && isAaPanelNginxActive()) {
    return {
      ok: false,
      errorMessage:
        'Nginx aaPanel sedang aktif. Install nginx Ubuntu dibatalkan agar tidak berebut port 80/443 atau membuat konfigurasi salah sasaran. ' +
        'Gunakan Nginx aaPanel yang ada, atau migrasikan dan matikan aaPanel Nginx secara manual terlebih dahulu.',
    };
  }

  const simulation = findPlannedRemovals(tool.pkg);
  if (!simulation.ok) {
    return { ok: false, errorMessage: 'Simulasi apt gagal, install dibatalkan demi keamanan: ' + simulation.errorMessage };
  }
  if (simulation.packages.length > 0) {
    return {
      ok: false,
      errorMessage:
        tool.name + ' tidak jadi diinstall karena apt berencana menghapus: ' + simulation.packages.join(', ') + '. ' +
        'Tidak ada perubahan dilakukan. Backup dan migrasikan manual bila memang ingin mengganti package tersebut.',
    };
  }

  const result = shell.runArgs('sudo', ['apt-get', 'install', '-y', tool.pkg], { timeoutMs: 5 * 60 * 1000 });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  // PostgreSQL bawaan Ubuntu hanya mengizinkan role postgres lewat peer
  // socket. Panel memakai TCP, jadi password harus diinisialisasi sekarang.
  if (key === 'postgresql') {
    const setup = postgres.setupRootPostgres();
    if (!setup.ok) return { ok: false, errorMessage: setup.errorMessage };
    return { ok: true, output: (result.output + '\n' + setup.message).trim() };
  }

  return { ok: true, output: result.output };
}

/**
 * Uninstall satu tool lewat `sudo apt-get remove -y <pkg>` (BUKAN `purge` -
 * `remove` doang, config file/data yang udah ada dibiarin, jadi kalau
 * di-install ulang lagi settingannya masih ada - lebih aman/reversible
 * daripada purge). Sama pola kayak installTool(): `pkg` SELALU dari TOOLS
 * (lookup by key), gak pernah dari body request langsung.
 */
function uninstallToolUnlocked(key) {
  const tool = findTool(key);
  if (!tool) return { ok: false, errorMessage: `Tool "${key}" tidak dikenal.` };

  const result = shell.runArgs('sudo', ['apt-get', 'remove', '-y', tool.pkg], { timeoutMs: 3 * 60 * 1000 });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true, output: result.output };
}

function runWithToolsLock(fn) {
  try {
    return withFileLock(TOOLS_LOCK_PATH, fn, { timeoutMs: 1500, staleMs: 10 * 60 * 1000 });
  } catch (err) {
    return { ok: false, errorMessage: 'Operasi install/uninstall lain masih berjalan. Tunggu sampai selesai lalu coba lagi. (' + err.message + ')' };
  }
}

function installTool(key) {
  return runWithToolsLock(() => installToolUnlocked(key));
}

function uninstallTool(key) {
  return runWithToolsLock(() => uninstallToolUnlocked(key));
}

module.exports = {
  TOOLS,
  detectTools,
  installTool,
  uninstallTool,
  findTool,
  isPkgInstalled,
  isAaPanelNginxActive,
  findPlannedRemovals,
  findOccupiedPorts,
};
