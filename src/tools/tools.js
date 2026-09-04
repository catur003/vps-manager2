const shell = require('../utils/shell');

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
 * Deteksi terinstall/tidaknya tiap tool via `which` (gak butuh sudo, cuma
 * baca PATH). Buat tool yang checkBin-nya null (plugin, bukan binary
 * mandiri), dicek via `dpkg -s <pkg>` sebagai gantinya.
 */
function detectTools() {
  return TOOLS.map((t) => {
    if (t.checkBin) {
      const result = shell.runArgs('which', [t.checkBin], { silent: true });
      return { key: t.key, name: t.name, category: t.category, installed: result.ok && !!result.output };
    }
    const result = shell.runArgs('dpkg', ['-s', t.pkg], { silent: true });
    return { key: t.key, name: t.name, category: t.category, installed: result.ok };
  });
}

/**
 * Install satu tool lewat `sudo apt-get install -y <pkg>`. `pkg` SELALU dari
 * TOOLS di atas (lookup by key), never dari body request langsung - jadi
 * sudoers bisa di-scope exact per paket (lihat setup-sudoers.sh) tanpa buka
 * celah "apt-get install -y <apa aja>".
 */
function installTool(key) {
  const tool = findTool(key);
  if (!tool) return { ok: false, errorMessage: `Tool "${key}" tidak dikenal.` };

  const updateResult = shell.runArgs('sudo', ['apt-get', 'update'], { timeoutMs: 2 * 60 * 1000 });
  if (!updateResult.ok) {
    return { ok: false, errorMessage: `apt-get update gagal: ${updateResult.errorMessage}` };
  }

  const result = shell.runArgs('sudo', ['apt-get', 'install', '-y', tool.pkg], { timeoutMs: 5 * 60 * 1000 });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true, output: result.output };
}

/**
 * Uninstall satu tool lewat `sudo apt-get remove -y <pkg>` (BUKAN `purge` -
 * `remove` doang, config file/data yang udah ada dibiarin, jadi kalau
 * di-install ulang lagi settingannya masih ada - lebih aman/reversible
 * daripada purge). Sama pola kayak installTool(): `pkg` SELALU dari TOOLS
 * (lookup by key), gak pernah dari body request langsung.
 */
function uninstallTool(key) {
  const tool = findTool(key);
  if (!tool) return { ok: false, errorMessage: `Tool "${key}" tidak dikenal.` };

  const result = shell.runArgs('sudo', ['apt-get', 'remove', '-y', tool.pkg], { timeoutMs: 3 * 60 * 1000 });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true, output: result.output };
}

module.exports = { TOOLS, detectTools, installTool, uninstallTool, findTool };
