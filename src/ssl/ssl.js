const shell = require('../utils/shell');
const config = require('../config/config');

function certPaths(domain) {
  const base = `/etc/letsencrypt/live/${domain}`;
  return {
    fullchain: `${base}/fullchain.pem`,
    privkey: `${base}/privkey.pem`,
  };
}

/**
 * Cek apakah sertifikat sudah ada untuk domain ini.
 */
function checkCertExists(domain) {
  const { fullchain, privkey } = certPaths(domain);
  const result = shell.run(`sudo test -f "${fullchain}" && sudo test -f "${privkey}" && echo yes || echo no`, {
    silent: true,
  });
  return result.ok && result.output.trim() === 'yes';
}

/**
 * Pastikan webroot buat validasi ACME challenge ada dan bisa dibaca nginx.
 */
function ensureWebroot() {
  const webroot = config.loadConfig().certbot_webroot;
  return shell.run(`sudo mkdir -p "${webroot}/.well-known/acme-challenge" && sudo chmod -R 755 "${webroot}"`);
}

/**
 * Terbitin sertifikat baru pakai certbot metode webroot (independen dari config
 * nginx yang kompleks, jadi tetap jalan walau aaPanel nanti dicabut).
 * PENTING: domain (dan semua `aliases`, mis. "www.domain") harus sudah bisa
 * diakses via HTTP (port 80) dan folder webroot harus sudah di-mount di config
 * nginx site tersebut (location /.well-known/acme-challenge/) - lihat
 * nginx.createReverseProxySite/upgradeToSSL yang sekarang nulis SEMUA nama
 * (domain + aliases) ke satu baris `server_name`, jadi satu vhost yang sama
 * nangkep request buat domain apex maupun alias-nya.
 *
 * `aliases`: domain tambahan yang mau ikut masuk SAN sertifikat yang SAMA
 * (satu sertifikat multi-domain), bukan sertifikat terpisah - ini yang bikin
 * "www.domain" bisa ikut HTTPS tanpa didaftarin sebagai project sendiri.
 *
 * `options.wildcard`: kalau `true`, JALUR TOTAL BEDA - webroot (HTTP-01)
 * TIDAK BISA nerbitin wildcard sama sekali (batasan protokol ACME, bukan
 * batasan certbot), WAJIB DNS-01 lewat plugin `dns-cloudflare` (baca token
 * dari file di `cloudflare_credentials_path`, certbot yang otomatis
 * bikin+hapus TXT record `_acme-challenge.domain` lewat API Cloudflare).
 * `aliases` DIABAIKAN kalau wildcard true - `*.domain` udah nyakup SEMUA
 * subdomain, alias satu-satu jadi gak relevan lagi.
 */
function issueCertificate(domain, aliases = [], options = {}) {
  const { wildcard = false } = options;

  if (!shell.commandExists('certbot')) {
    return {
      ok: false,
      errorMessage: 'Certbot belum terinstall di server. Install dulu: sudo apt install certbot',
    };
  }

  const email = config.loadConfig().certbot_email;
  const emailFlag = email ? `-m ${email}` : '--register-unsafely-without-email';

  if (wildcard) {
    const cfPath = config.loadConfig().cloudflare_credentials_path;
    if (!cfPath) {
      return {
        ok: false,
        errorMessage: 'Wildcard butuh Cloudflare API token dulu - setup lewat POST /ssl/cloudflare-setup sebelum coba lagi.',
      };
    }
    const cfCheck = shell.run(`sudo test -f "${cfPath}" && echo yes || echo no`, { silent: true });
    if (!cfCheck.ok || cfCheck.output.trim() !== 'yes') {
      return { ok: false, errorMessage: `File credentials Cloudflare ("${cfPath}") gak ketemu di server - setup ulang lewat POST /ssl/cloudflare-setup.` };
    }

    const domainFlags = `-d ${domain} -d *.${domain}`;
    // --dns-cloudflare-propagation-seconds: default plugin 10 detik,
    // dinaikin ke 25 - kadang TXT record Cloudflare butuh waktu propagasi
    // dikit lebih lama dari default sebelum Let's Encrypt validasi berhasil,
    // gagal di sini bukan berarti config salah, cuma race DNS-propagation.
    const cmd = `sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials "${cfPath}" --dns-cloudflare-propagation-seconds 25 ${domainFlags} --cert-name ${domain} --expand --non-interactive --agree-tos ${emailFlag}`;
    const result = shell.run(cmd, { timeoutMs: 120000 });
    if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

    if (!checkCertExists(domain)) {
      return { ok: false, errorMessage: 'Certbot selesai tapi file sertifikat tidak ditemukan di lokasi yang diharapkan.' };
    }
    return { ok: true, ...certPaths(domain) };
  }

  const ensureResult = ensureWebroot();
  if (!ensureResult.ok) return { ok: false, errorMessage: ensureResult.errorMessage };

  const webroot = config.loadConfig().certbot_webroot;

  const domainFlags = [domain, ...aliases].map((d) => `-d ${d}`).join(' ');
  // --cert-name dipaksa = domain utama (BUKAN dibiarkan certbot nebak dari
  // urutan -d) supaya folder sertifikat SELALU konsisten di
  // /etc/letsencrypt/live/${domain} sesuai certPaths() - kalau dibiarkan
  // default, certbot bisa bikin lineage baru bernama alias (mis.
  // "www.domain-0001") kalau urutan/isi -d berubah antar issue & re-issue.
  // --expand mengizinkan nambah/ganti daftar SAN ke sertifikat lineage yang
  // sama tanpa certbot nolak/nanya interaktif (perlu untuk alur "tambah
  // alias lalu re-issue" di domains.routes.js).
  const cmd = `sudo certbot certonly --webroot -w "${webroot}" ${domainFlags} --cert-name ${domain} --expand --non-interactive --agree-tos ${emailFlag}`;
  const result = shell.run(cmd);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  if (!checkCertExists(domain)) {
    return { ok: false, errorMessage: 'Certbot selesai tapi file sertifikat tidak ditemukan di lokasi yang diharapkan.' };
  }

  return { ok: true, ...certPaths(domain) };
}

/**
 * Renew semua sertifikat yang mendekati expired (certbot otomatis skip yang belum waktunya).
 */
function renewAll() {
  return shell.run('sudo certbot renew --non-interactive');
}

/**
 * Cek sisa masa berlaku sertifikat sebuah domain (dalam hari).
 */
function checkExpiry(domain) {
  const { fullchain } = certPaths(domain);
  const result = shell.run(`sudo openssl x509 -enddate -noout -in "${fullchain}"`, { silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  const match = result.output.match(/notAfter=(.+)/);
  if (!match) return { ok: false, errorMessage: 'Gagal membaca tanggal expired.' };

  const expiryDate = new Date(match[1]);
  const daysLeft = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
  return { ok: true, expiryDate, daysLeft };
}

/**
 * Setup awal wildcard SSL: install plugin `certbot-dns-cloudflare` (kalau
 * belum ada) + tulis file credentials INI (format wajib plugin ini:
 * `dns_cloudflare_api_token = <token>`) ke `/etc/letsencrypt/cloudflare.ini`,
 * chmod 600 (SAMA ketatnya kayak config.json - token ini setara password
 * penuh ke akun Cloudflare buat domain yang di-scope token-nya). Path-nya
 * disimpen ke config (`cloudflare_credentials_path`), token MENTAHNYA
 * TIDAK PERNAH disimpen di config.json - cuma di file INI itu sendiri.
 */
function setupCloudflareCredentials(apiToken) {
  const installResult = shell.run('sudo apt-get install -y python3-certbot-dns-cloudflare');
  if (!installResult.ok) {
    return { ok: false, errorMessage: `Gagal install plugin certbot-dns-cloudflare: ${installResult.errorMessage}` };
  }

  const iniPath = '/etc/letsencrypt/cloudflare.ini';
  const iniContent = `dns_cloudflare_api_token = ${apiToken}\n`;
  const writeCmd = `echo '${iniContent.replace(/'/g, `'\\''`)}' | sudo tee "${iniPath}" > /dev/null && sudo chmod 600 "${iniPath}"`;
  const writeResult = shell.run(writeCmd, { silent: true }); // silent - jangan log token ke mana-mana
  if (!writeResult.ok) {
    return { ok: false, errorMessage: `Gagal tulis file credentials: ${writeResult.errorMessage}` };
  }

  config.updateConfig('cloudflare_credentials_path', iniPath);
  return { ok: true };
}

module.exports = { certPaths, checkCertExists, ensureWebroot, issueCertificate, renewAll, checkExpiry, setupCloudflareCredentials };
