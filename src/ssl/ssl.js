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
 * PENTING: domain harus sudah bisa diakses via HTTP (port 80) dan folder webroot
 * harus sudah di-mount di config nginx site tersebut (location /.well-known/acme-challenge/).
 */
function issueCertificate(domain) {
  if (!shell.commandExists('certbot')) {
    return {
      ok: false,
      errorMessage: 'Certbot belum terinstall di server. Install dulu: sudo apt install certbot',
    };
  }

  const ensureResult = ensureWebroot();
  if (!ensureResult.ok) return { ok: false, errorMessage: ensureResult.errorMessage };

  const webroot = config.loadConfig().certbot_webroot;
  const email = config.loadConfig().certbot_email;
  const emailFlag = email ? `-m ${email}` : '--register-unsafely-without-email';

  const cmd = `sudo certbot certonly --webroot -w "${webroot}" -d ${domain} --non-interactive --agree-tos ${emailFlag}`;
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

module.exports = { certPaths, checkCertExists, ensureWebroot, issueCertificate, renewAll, checkExpiry };
