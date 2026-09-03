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
  { key: 'mysql', name: 'MySQL Server', category: 'Database', checkBin: 'mysql', pkg: 'mysql-server' },
  { key: 'postgresql', name: 'PostgreSQL', category: 'Database', checkBin: 'psql', pkg: 'postgresql' },
  { key: 'redis', name: 'Redis', category: 'Database', checkBin: 'redis-cli', pkg: 'redis-server' },
  { key: 'memcached', name: 'Memcached', category: 'Database', checkBin: 'memcached', pkg: 'memcached' },
  // --- Runtime & Build ---
  { key: 'docker', name: 'Docker Engine', category: 'Runtime', checkBin: 'docker', pkg: 'docker.io' },
  { key: 'build-essential', name: 'Build Essential (gcc/make)', category: 'Runtime', checkBin: 'make', pkg: 'build-essential' },
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
