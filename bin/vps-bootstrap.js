#!/usr/bin/env node

/**
 * Bootstrap orchestrator vps-manager - dipanggil SEKALI dari
 * scripts/install.sh, SETELAH bagian OS-level (buat deploy user, clone
 * repo, npm install, npm link, jalankan setup-sudoers.sh) selesai.
 *
 * KENAPA INI ADA (bukan sekadar port-over dari installFlow.ts mobile):
 * Sebelumnya SATU-SATUNYA cara provisioning otomatis adalah lewat app
 * mobile yang SSH ke server dan jalanin command mentah satu-satu
 * (installFlow.ts). Itu rapuh - kalau koneksi SSH dari HP putus di tengah,
 * state cuma hidup di React state (ilang kalau pindah tab), dan yang lebih
 * parah: logic install (syntax SQL, cek firewall, dst) jadi DUPLIKAT dari
 * logic yang sama di sini (src/database/database.js, dll) - kalau satu
 * dibenerin yang satu lagi kelupaan (persis kejadian bug "IDENTIFIED WITH
 * mysql_native_password BY" yang cuma kefix di satu tempat, ketauan lewat
 * laporan Zen).
 *
 * Installer ini SEBALIKNYA: jalan LANGSUNG DI SERVER (bukan di-remote-
 * control lewat SSH dari HP), dan SEMUA langkah manggil module Node yang
 * SAMA dipakai REST API & CLI menu (database.js, nginx.js, ssl.js,
 * registry.js) - satu sumber kebenaran, fix di satu tempat otomatis
 * kepakai di semua jalur. App mobile ke depan tinggal manggil endpoint
 * REST buat trigger/monitor bootstrap ini (via job async, sama polanya
 * kayak /deploy dan /ssl/issue yang udah ada), BUKAN lagi orkestrasi
 * command satu-satu lewat SSH.
 *
 * Idempotent - aman dijalanin ulang kalau sempat gagal di tengah (tiap
 * step ngecek dulu apa udah beres sebelum ngerjain ulang).
 *
 * ENV VAR yang dibaca:
 *   BOOTSTRAP_DOMAIN       (opsional kalau direct HTTPS aktif)
 *   BOOTSTRAP_DIRECT_HTTPS (1 untuk akses langsung via IP)
 *   BOOTSTRAP_PUBLIC_HOST  (IP/hostname yang dibuka user)
 *   BOOTSTRAP_PUBLIC_PORT  (default: 4001)
 *   BOOTSTRAP_TLS_KEY      (path private key self-signed)
 *   BOOTSTRAP_TLS_CERT     (path certificate self-signed)
 *   BOOTSTRAP_DEPLOY_USER  (opsional, default: $USER proses ini)
 *   BOOTSTRAP_PORT         (opsional, default: 4001)
 *   BOOTSTRAP_REPO_PATH    (opsional, default: cwd proses ini)
 */

const path = require('path');
const config = require('../src/config/config');
const authStore = require('../src/auth/authStore');
const database = require('../src/database/database');
const nginx = require('../src/nginx/nginx');
const ssl = require('../src/ssl/ssl');
const registry = require('../src/registry/registry');
const shell = require('../src/utils/shell');
const logger = require('../src/utils/logger');

async function main() {
  const domain = process.env.BOOTSTRAP_DOMAIN;
  const directHttps = process.env.BOOTSTRAP_DIRECT_HTTPS === '1';
  const publicHost = process.env.BOOTSTRAP_PUBLIC_HOST || '';
  const publicPort = parseInt(process.env.BOOTSTRAP_PUBLIC_PORT || '4001', 10);
  const deployUser = process.env.BOOTSTRAP_DEPLOY_USER || process.env.USER;
  const port = parseInt(process.env.BOOTSTRAP_PORT || (directHttps ? '4002' : '4001'), 10);
  const repoPath = process.env.BOOTSTRAP_REPO_PATH || process.cwd();
  const deferPm2Startup = process.env.BOOTSTRAP_DEFER_PM2_STARTUP === '1';
  const preservePlatformConfig = process.env.BOOTSTRAP_PRESERVE_PLATFORM_CONFIG === '1';

  if (!domain && !directHttps) {
    logger.error('Isi BOOTSTRAP_DOMAIN atau aktifkan BOOTSTRAP_DIRECT_HTTPS=1.');
    process.exit(1);
  }
  if (directHttps && (!publicHost || !process.env.BOOTSTRAP_TLS_KEY || !process.env.BOOTSTRAP_TLS_CERT)) {
    logger.error('Direct HTTPS butuh BOOTSTRAP_PUBLIC_HOST, BOOTSTRAP_TLS_KEY, dan BOOTSTRAP_TLS_CERT.');
    process.exit(1);
  }
  if (!deployUser) {
    logger.error('Gagal deteksi deploy user (BOOTSTRAP_DEPLOY_USER kosong dan $USER juga kosong).');
    process.exit(1);
  }

  logger.title('vps-manager Bootstrap');
  logger.info(`Akses: ${domain || ('https://' + publicHost + ':' + publicPort)} | Deploy user: ${deployUser} | Port internal: ${port}`);

  // Installer mengirim hasil deteksi platform secara eksplisit. Ini membuat
  // fresh Ubuntu memakai nginx paket distro, tetapi instalasi aaPanel lama
  // tetap bisa memakai path aaPanel tanpa hardcode salah satu lingkungan.
  if (!preservePlatformConfig) {
    const platformCfg = config.loadConfig();
    platformCfg.deploy_user = deployUser;
    platformCfg.default_folder = process.env.BOOTSTRAP_APPS_DIR || platformCfg.default_folder;
    platformCfg.docker_projects_dir = process.env.BOOTSTRAP_DOCKER_DIR || platformCfg.docker_projects_dir || '/opt/docker';
    platformCfg.certbot_webroot = process.env.BOOTSTRAP_CERTBOT_DIR || platformCfg.certbot_webroot;
    platformCfg.nginx_conf_dir = process.env.BOOTSTRAP_NGINX_CONF_DIR || platformCfg.nginx_conf_dir;
    platformCfg.nginx_binary = process.env.BOOTSTRAP_NGINX_BINARY || platformCfg.nginx_binary;
    platformCfg.nginx_log_dir = process.env.BOOTSTRAP_NGINX_LOG_DIR || platformCfg.nginx_log_dir;
    config.saveConfig(platformCfg);
  }

  // 0/6 - Self-heal ownership SEBELUM apa-apa lagi (FIXED, laporan Zen
  // berulang: config.json/data/ kena EACCES pas dibaca proses PM2 yang
  // jalan sebagai deploy_user). Root cause-nya macem-macem (folder repo
  // ke-clone di home user lain, atau CLI sempet dijalanin lewat `sudo
  // vps-manager` polos - bukan `sudo -u <deployUser>` - yang bikin
  // config.json ke-tulis ulang milik root). Daripada ngejar SEMUA
  // kemungkinan penyebab satu-satu, installer ini defensif: PASTIKAN
  // ownership repo + folder data benar di TITIK AWAL setiap kali bootstrap
  // dijalankan (aman - chown ke user yang sama gak ngerusak apa-apa kalau
  // memang udah benar).
  const chownResult = shell.run(`sudo chown -R ${deployUser}:${deployUser} "${repoPath}"`, { silent: true });
  if (!chownResult.ok) {
    logger.warn(`Gagal self-heal ownership "${repoPath}" (${chownResult.errorMessage}) - lanjut, tapi kalau ada EACCES di step berikutnya, ini kemungkinan penyebabnya.`);
  }

  // 1/6 - Database
  logger.section('1/6 - Setup Database');
  const dbResult = database.setupRootDatabase();
  if (!dbResult.ok) {
    logger.error(`Gagal setup database: ${dbResult.errorMessage}`);
    logger.warn('Bootstrap berhenti di sini - benerin manual dulu, lalu jalankan ulang script ini (aman diulang).');
    process.exit(1);
  }
  logger.success(dbResult.message);

  // 2/6 - Auth web. API key sekarang opsional dan dibuat setelah login.
  logger.section('2/6 - Setup Administrator');
  const cfg = config.loadConfig();
  cfg.api = {
    ...(cfg.api || {}),
    port,
    public_port: publicPort,
    public_url: domain ? `https://${domain}` : `https://${publicHost}:${publicPort}`,
    direct_https: directHttps ? {
      enabled: true,
      key_path: process.env.BOOTSTRAP_TLS_KEY,
      cert_path: process.env.BOOTSTRAP_TLS_CERT,
    } : (cfg.api?.direct_https || { enabled: false, key_path: '', cert_path: '' }),
  };
  config.saveConfig(cfg);
  const authState = authStore.status();
  let setupToken = null;
  if (authState.initialized) {
    logger.info('Administrator sudah ada - setup token dilewati.');
  } else {
    setupToken = authStore.generateSetupToken();
    logger.card('SETUP TOKEN - SIMPAN SEKARANG', [
      setupToken.token,
      '',
      `Buka: ${cfg.api.public_url}/setup.html`,
      `Berlaku sampai: ${setupToken.expiresAt}`,
      `Kalau hilang/kedaluwarsa: cd ${repoPath} && node bin/vps-manager.js setup-token regenerate`,
    ], { color: 'red' });
  }

  // 3/6 - PM2 start + boot persistence
  logger.section('3/6 - PM2 Start & Boot Persistence');
  const apiScriptPath = path.join(repoPath, 'bin', 'vps-api.js');
  const listResult = shell.run('pm2 jlist', { silent: true });
  const alreadyRunning = listResult.ok && listResult.output.includes('"name":"vps-manager-api"');
  if (alreadyRunning) {
    logger.info('vps-manager-api udah jalan di PM2 - dilewatin, gak di-start ulang.');
  } else {
    const startResult = shell.run(
      `pm2 start "${apiScriptPath}" --name vps-manager-api --cwd "${repoPath}"`,
      { cwd: repoPath }
    );
    if (!startResult.ok) {
      logger.error(`Gagal start PM2: ${startResult.errorMessage}`);
      process.exit(1);
    }
    logger.success('vps-manager-api berhasil di-start lewat PM2.');
  }
  shell.run('pm2 save', { silent: true });

  // FIXED (gap baru ketauan pas nulis ulang bagian ini): SEBELUMNYA gak
  // pernah ada langkah "pm2 startup" di installer manapun (baik yang lama
  // di mobile, ataupun draft awal file ini) - artinya kalau VPS di-reboot,
  // vps-manager-api (dan SEMUA project lain yang dikelola PM2) TIDAK
  // otomatis nyala lagi kecuali ada yang manual jalanin "pm2 resurrect"
  // abis boot. "pm2 startup" generate command systemd yang HARUS
  // dieksekusi SEBAGAI ROOT buat daftar service boot-nya - proses ini
  // sendiri jalan sebagai deploy_user (bukan root), jadi command yang
  // di-generate perlu di-extract dulu baru dieksekusi lewat sudo terpisah.
  const startupCheck = shell.run(`systemctl is-enabled pm2-${deployUser} 2>/dev/null`, { silent: true });
  if (deferPm2Startup) {
    logger.info('Registrasi service boot PM2 akan diselesaikan installer sebagai root.');
  } else if (startupCheck.ok && startupCheck.output.trim() === 'enabled') {
    logger.info('PM2 boot persistence udah aktif sebelumnya - dilewatin.');
  } else {
    const startupGen = shell.run(`pm2 startup systemd -u ${deployUser} --hp /home/${deployUser}`, { silent: true });
    const sudoCmdMatch = (startupGen.output || '').match(/sudo env[^\n]+/);
    if (sudoCmdMatch) {
      const applyResult = shell.run(sudoCmdMatch[0]);
      applyResult.ok
        ? logger.success('PM2 boot persistence terpasang - project tetap nyala otomatis walau VPS reboot.')
        : logger.warn(`Gagal pasang PM2 startup otomatis (${applyResult.errorMessage}). Jalankan manual: ${sudoCmdMatch[0]}`);
    } else {
      logger.warn('Gagal generate command PM2 startup - lewati, boot persistence perlu disetel manual: pm2 startup');
    }
  }

  if (!domain) {
    logger.title('Bootstrap Selesai');
    logger.card('Akses Langsung', [
      `Panel        : ${cfg.api.public_url}/setup.html`,
      `Port publik  : ${publicPort} (HTTPS self-signed)`,
      `Port internal: ${port} (localhost only)`,
      '',
      'UFW sudah dibuka installer. Buka TCP port yang sama juga di',
      'firewall provider VPS (OCI Security List/NSG, AWS Security Group, dst).',
      'Cocokkan fingerprint sertifikat dari output installer.',
    ]);
    return;
  }

  // 4/6 - Register ke registry
  logger.section('4/6 - Daftarin ke Registry');
  try {
    registry.addProject({
      name: 'vps-manager-api',
      type: 'other',
      domain,
      port,
      path: repoPath,
      deploy_user: deployUser,
      imported: true,
    });
    logger.success('Terdaftar di registry.');
  } catch (err) {
    if (err.message.includes('sudah terdaftar')) {
      logger.info('Sudah terdaftar sebelumnya - dilewatin.');
    } else {
      logger.error(`Gagal daftar ke registry: ${err.message}`);
      process.exit(1);
    }
  }

  // 5/6 - Nginx (HTTP dulu, wajib buat validasi certbot webroot)
  logger.section('5/6 - Setup Nginx');
  // createReverseProxySite() idempotent (nulis ulang config), aman dipanggil
  // berkali-kali - sama persis behavior "Terbitkan SSL" di app: proses ini
  // MEMANG bikin ulang/menimpa file config nginx tiap dipanggil.
  const nginxResult = nginx.createReverseProxySite({ domain, port });
  if (!nginxResult.ok) {
    logger.error(`Gagal setup Nginx: ${nginxResult.errorMessage}`);
    logger.warn('Bootstrap berhenti di sini - domain harus sudah diarahkan (A record) ke IP VPS ini sebelum lanjut SSL.');
    process.exit(1);
  }
  logger.success('Nginx HTTP vhost aktif.');

  // 6/6 - SSL
  logger.section('6/6 - Terbitkan SSL');
  let httpsReady = false;
  if (ssl.checkCertExists(domain)) {
    const existingCert = {
      fullchain: `/etc/letsencrypt/live/${domain}/fullchain.pem`,
      privkey: `/etc/letsencrypt/live/${domain}/privkey.pem`,
    };
    const upgradeResult = nginx.upgradeToSSL({ domain, port, ...existingCert });
    httpsReady = upgradeResult.ok;
    upgradeResult.ok
      ? logger.success(`Sertifikat lama ditemukan dan HTTPS aktif untuk "${domain}".`)
      : logger.warn(`Sertifikat ditemukan tapi gagal upgrade Nginx ke HTTPS: ${upgradeResult.errorMessage}`);
  } else {
    const sslResult = ssl.issueCertificate(domain, []);
    if (!sslResult.ok) {
      logger.warn(
        `SSL gagal diterbitkan otomatis: ${sslResult.errorMessage}\n` +
        `Pastikan domain "${domain}" sudah diarahkan (DNS A record) ke IP VPS ini, lalu coba lagi lewat menu SSL Manager.`
      );
    } else {
      const upgradeResult = nginx.upgradeToSSL({ domain, port, fullchain: sslResult.fullchain, privkey: sslResult.privkey });
      httpsReady = upgradeResult.ok;
      upgradeResult.ok
        ? logger.success(`HTTPS aktif untuk "${domain}".`)
        : logger.warn(`SSL terbit tapi gagal upgrade Nginx ke HTTPS: ${upgradeResult.errorMessage}`);
    }
  }

  logger.title('Bootstrap Selesai');
  const finalCfg = config.loadConfig();
  finalCfg.api = { ...(finalCfg.api || {}), public_url: `${httpsReady ? 'https' : 'http'}://${domain}` };
  config.saveConfig(finalCfg);
  logger.card('Ringkasan', [
    `API URL   : ${httpsReady ? 'https' : 'http'}://${domain}`,
    `Deploy user: ${deployUser}`,
    `Repo path : ${repoPath}`,
    '',
    `Setup admin: ${httpsReady ? 'https' : 'http'}://${domain}/setup.html`,
    'API token untuk mobile/bot dapat dibuat terpisah setelah login.',
  ]);
}

main().catch((err) => {
  logger.error(`Bootstrap gagal dengan error gak terduga: ${err.message}`);
  process.exit(1);
});
