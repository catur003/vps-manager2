const fs = require('fs');
const path = require('path');
const shell = require('../utils/shell');
const config = require('../config/config');

function confDir() {
  return config.loadConfig().nginx_conf_dir;
}

/**
 * Struktur folder nginx ada 2 gaya berbeda:
 * - aaPanel: satu folder vhost (mis. /www/server/panel/vhost/nginx), nginx.conf
 *   langsung `include` semua file di situ dengan wildcard - taruh file = langsung aktif.
 * - Debian/Ubuntu standar: `sites-available` cuma tempat SIMPAN config, yang benar-benar
 *   dibaca nginx adalah symlink di `sites-enabled` (nginx.conf isinya
 *   `include /etc/nginx/sites-enabled/*;`). Taruh file di sites-available SAJA tanpa
 *   symlink ke sites-enabled = file kebentuk tapi nginx nggak pernah baca sama sekali,
 *   walau `nginx -t` dan reload keliatan "sukses" (karena keduanya cuma soal file yang
 *   SUDAH ke-include, bukan ngecek file baru yang belum di-enable).
 *
 * Fungsi ini return path folder `sites-enabled` yang sesuai KALAU nginx_conf_dir
 * memang polanya "sites-available" ala Debian/Ubuntu, atau `null` kalau bukan
 * (berarti gaya aaPanel / single-folder, nggak perlu symlink apa-apa).
 */
function enabledDir() {
  const cfg = config.loadConfig();
  if (cfg.nginx_enabled_dir) return cfg.nginx_enabled_dir; // override eksplisit kalau ada
  const dir = cfg.nginx_conf_dir || '';
  if (/\/sites-available\/?$/.test(dir)) {
    return dir.replace(/\/sites-available\/?$/, '/sites-enabled');
  }
  return null; // gaya aaPanel / single-folder, tidak butuh symlink
}

/**
 * Pastikan file di sites-available ke-symlink ke sites-enabled (kalau struktur
 * folder memang butuh itu - lihat enabledDir()). Idempotent: aman dipanggil
 * berkali-kali, tidak bikin symlink dobel.
 */
function ensureEnabled(filename) {
  const dir = enabledDir();
  if (!dir) return { ok: true, skipped: true }; // gaya aaPanel, tidak relevan

  const target = path.join(confDir(), filename);
  const linkPath = path.join(dir, filename);

  // runArgs (execFileSync) - path dikirim sebagai argv terpisah, bukan
  // digabung jadi satu string yang di-parse shell. Lihat catatan keamanan
  // di database.js runSQL() soal kenapa ini wajib untuk value yang bisa
  // berasal dari request API (mis. `filename` dari route nginx).
  const mkdirResult = shell.runArgs('sudo', ['mkdir', '-p', dir]);
  if (!mkdirResult.ok) return { ok: false, errorMessage: mkdirResult.errorMessage };

  // -f biar aman ditimpa kalau symlink lama nyasar ke path yang salah/beda
  const linkResult = shell.runArgs('sudo', ['ln', '-sf', target, linkPath]);
  if (!linkResult.ok) return { ok: false, errorMessage: linkResult.errorMessage };

  return { ok: true, skipped: false };
}

/**
 * Kebalikan dari ensureEnabled() - lepas symlink di sites-enabled (kalau ada),
 * dipakai pas deleteSite(). Tidak menghapus file asli di sites-available.
 */
function ensureDisabled(filename) {
  const dir = enabledDir();
  if (!dir) return { ok: true, skipped: true };
  const linkPath = path.join(dir, filename);
  return shell.runArgs('sudo', ['rm', '-f', linkPath]);
}

/**
 * List semua file .conf di folder vhost nginx, dengan info server_name & target (proxy/root).
 */
function listSites() {
  const dir = confDir();
  const result = shell.runArgs('sudo', ['ls', dir], { silent: true });
  if (!result.ok) return { ok: false, sites: [], error: result.errorMessage };

  const files = result.output.split('\n').filter((f) => f.endsWith('.conf'));
  const sites = files
    .map((file) => {
      const contentResult = shell.runArgs('sudo', ['cat', path.join(dir, file)], { silent: true });
      const content = contentResult.ok ? contentResult.output : '';
      const serverName = (content.match(/server_name\s+([^;]+);/) || [])[1] || null;
      const proxyPass = (content.match(/proxy_pass\s+([^;]+);/) || [])[1] || null;
      const root = (content.match(/root\s+([^;]+);/) || [])[1] || null;
      return {
        file,
        domain: serverName ? serverName.trim() : null,
        target: proxyPass ? `proxy -> ${proxyPass.trim()}` : root ? `static -> ${root.trim()}` : '-',
      };
    })
    .filter((s) => s.domain !== null); // buang snippet/include yang bukan site sungguhan (fastcgi_cache, websocket, dll)

  return { ok: true, sites };
}

function viewSite(file) {
  return shell.runArgs('sudo', ['cat', path.join(confDir(), file)], { silent: true });
}

/**
 * Bungkus baris `return 301 https://$host$request_uri;` yang masih nempel
 * langsung di level `server` (bukan di dalam `location`), jadi masuk ke
 * `location / { ... }`. Kalau dibiarkan di level server, redirect ini bakal
 * ke-trigger duluan buat SEMUA request termasuk /.well-known/acme-challenge/,
 * bikin certbot gagal validasi.
 */
function wrapBareRedirect(content) {
  const lines = content.split('\n');
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    if (!/return 301 https:\/\/\$host\$request_uri;/.test(lines[i])) continue;

    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j--;
    const prevLine = j >= 0 ? lines[j].trim() : '';
    if (prevLine.startsWith('location')) continue; // udah dibungkus, biarin

    const indent = (lines[i].match(/^(\s*)/) || ['', ''])[1];
    lines[i] = `${indent}location / {\n${indent}    return 301 https://$host$request_uri;\n${indent}}`;
    changed = true;
  }

  return { content: lines.join('\n'), changed };
}

/**
 * Pastikan config site (apapun asalnya - punya tool ini atau punya aaPanel) sudah
 * punya location /.well-known/acme-challenge/ DAN nggak ada redirect 301 yang
 * masih level server (yang bisa nge-block ACME challenge), karena certbot webroot
 * butuh keduanya bener biar validasi jalan. Kalau semua udah aman, tidak diapa-apakan.
 */
function ensureAcmeChallenge(file) {
  const targetPath = path.join(confDir(), file);
  const readResult = shell.runArgs('sudo', ['cat', targetPath], { silent: true });
  if (!readResult.ok) return { ok: false, errorMessage: readResult.errorMessage };

  let content = readResult.output;
  let changed = false;

  if (!content.includes('acme-challenge')) {
    const webroot = config.loadConfig().certbot_webroot;
    const injection = `\n    location /.well-known/acme-challenge/ {\n        root ${webroot};\n    }\n`;
    const serverNameMatch = content.match(/server_name[^;]+;/);
    if (!serverNameMatch) {
      return { ok: false, errorMessage: 'Tidak ditemukan baris server_name, gagal menyuntikkan ACME route otomatis.' };
    }
    content = content.replace(serverNameMatch[0], serverNameMatch[0] + injection);
    changed = true;
  }

  const wrapResult = wrapBareRedirect(content);
  content = wrapResult.content;
  if (wrapResult.changed) changed = true;

  if (!changed) {
    return { ok: true, changed: false };
  }

  backupSite(file);
  const tmpFile = `/tmp/${file}.acme.${Date.now()}`;
  fs.writeFileSync(tmpFile, content);
  const copyResult = shell.runArgs('sudo', ['cp', tmpFile, targetPath]);
  fs.unlinkSync(tmpFile);
  if (!copyResult.ok) return { ok: false, errorMessage: copyResult.errorMessage };

  const test = testConfig();
  if (!test.ok) {
    return { ok: false, errorMessage: `Config jadi invalid setelah perbaikan ACME route:\n${test.errorMessage}` };
  }

  // Jaga-jaga: kalau site ini sebelumnya kebuat sebelum fix symlink ini ada
  // (jadi filenya cuma nangkring di sites-available, belum pernah ter-enable),
  // pastikan sekarang ke-symlink juga sebelum reload.
  const enableResult = ensureEnabled(file);
  if (!enableResult.ok) return { ok: false, errorMessage: enableResult.errorMessage };

  const reloadResult = reload();
  if (!reloadResult.ok) return { ok: false, errorMessage: reloadResult.errorMessage };

  return { ok: true, changed: true };
}

function nginxBin() {
  return config.loadConfig().nginx_binary;
}

/**
 * Test syntax config nginx sebelum reload (mencegah nginx down total kalau ada typo).
 * PENTING: pakai binary aaPanel (bukan `nginx`/`systemctl` sistem), karena di server
 * dengan aaPanel, instance nginx yang benar-benar aktif (bind port 80/443) adalah
 * /www/server/nginx/sbin/nginx, bukan paket nginx Ubuntu biasa.
 */
function testConfig() {
  return shell.runArgs('sudo', [nginxBin(), '-t'], { silent: true });
}

function reload() {
  const test = testConfig();
  if (!test.ok) {
    return { ok: false, errorMessage: `Config nginx error, reload dibatalkan:\n${test.errorMessage}` };
  }
  return shell.runArgs('sudo', [nginxBin(), '-s', 'reload']);
}

/**
 * Backup file config sebelum diubah/dihapus (safety net sesuai prinsip Safety System).
 */
function backupSite(file) {
  const src = path.join(confDir(), file);
  const backupPath = `${src}.bak-${Date.now()}`;
  return shell.runArgs('sudo', ['cp', src, backupPath]);
}

/**
 * Tulis file config nginx (lewat /tmp dulu supaya bisa dipindah pakai sudo),
 * lalu test. Kalau invalid, file dihapus lagi (nggak jadi dipasang).
 */
function writeConfFile(filename, template) {
  const dir = confDir();
  const targetPath = path.join(dir, filename);
  const tmpFile = `/tmp/${filename}.${Date.now()}`;

  // Config sekarang selalu nulis access_log/error_log ke nginx_log_dir (lihat
  // createReverseProxySite/upgradeToSSL) - kalau foldernya belum ada, nginx -t
  // gagal dengan "open() ... failed (No such file or directory)". Pastikan
  // ada dulu sebelum config yang mereferensikannya di-test/reload.
  const logDir = config.loadConfig().nginx_log_dir;
  if (logDir) shell.runArgs('sudo', ['mkdir', '-p', logDir]);

  fs.writeFileSync(tmpFile, template);
  const copyResult = shell.runArgs('sudo', ['cp', tmpFile, targetPath]);
  fs.unlinkSync(tmpFile);

  if (!copyResult.ok) return copyResult;

  // Kalau struktur foldernya ala Debian/Ubuntu (sites-available/sites-enabled),
  // symlink WAJIB dibuat DULU sebelum test - kalau nggak, nginx -t cuma nge-tes
  // konfigurasi yang sudah aktif sekarang (belum termasuk site baru ini), jadi
  // "sukses" padahal site-nya nggak bakal pernah kebaca nginx.
  const enableResult = ensureEnabled(filename);
  if (!enableResult.ok) {
    shell.runArgs('sudo', ['rm', targetPath]);
    return { ok: false, errorMessage: `Gagal enable site (symlink ke sites-enabled):\n${enableResult.errorMessage}` };
  }

  const test = testConfig();
  if (!test.ok) {
    ensureDisabled(filename);
    shell.runArgs('sudo', ['rm', targetPath]);
    return { ok: false, errorMessage: `Config invalid, dibatalkan:\n${test.errorMessage}` };
  }

  return reload();
}

/**
 * Buat site baru sebagai reverse proxy ke localhost:port (dipakai untuk app Node/PM2).
 * Selalu menyertakan location /.well-known/acme-challenge/ supaya nanti bisa
 * langsung dipakai certbot webroot tanpa perlu edit ulang config.
 */
function createReverseProxySite({ domain, port }) {
  const webroot = config.loadConfig().certbot_webroot;
  const logDir = config.loadConfig().nginx_log_dir;
  const template = `server {
    listen 80;
    server_name ${domain};

    access_log ${logDir}/${domain}.access.log;
    error_log ${logDir}/${domain}.error.log;

    location /.well-known/acme-challenge/ {
        root ${webroot};
    }

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
`;
  return writeConfFile(`${domain}.conf`, template);
}

/**
 * Upgrade site existing (HTTP-only) jadi HTTPS: port 80 redirect ke 443,
 * port 443 serve reverse proxy dengan sertifikat dari certbot.
 * Config lama di-backup dulu sebelum ditimpa (safety net).
 */
function upgradeToSSL({ domain, port, fullchain, privkey }) {
  const filename = `${domain}.conf`;
  const dir = confDir();
  const existingPath = path.join(dir, filename);
  if (fs.existsSync(existingPath) || shell.runArgs('sudo', ['test', '-f', existingPath]).ok) {
    backupSite(filename);
  }

  const webroot = config.loadConfig().certbot_webroot;
  const logDir = config.loadConfig().nginx_log_dir;
  const template = `server {
    listen 80;
    server_name ${domain};

    location /.well-known/acme-challenge/ {
        root ${webroot};
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${domain};

    access_log ${logDir}/${domain}.access.log;
    error_log ${logDir}/${domain}.error.log;

    ssl_certificate ${fullchain};
    ssl_certificate_key ${privkey};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
`;
  return writeConfFile(filename, template);
}

function deleteSite(file) {
  backupSite(file);
  ensureDisabled(file);
  const result = shell.runArgs('sudo', ['rm', path.join(confDir(), file)]);
  if (!result.ok) return result;
  return reload();
}

module.exports = {
  listSites,
  viewSite,
  testConfig,
  reload,
  backupSite,
  createReverseProxySite,
  upgradeToSSL,
  ensureAcmeChallenge,
  deleteSite,
  enabledDir,
  ensureEnabled,
  ensureDisabled,
};
