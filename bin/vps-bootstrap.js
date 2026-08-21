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
 *   BOOTSTRAP_DOMAIN       (wajib) - domain buat vps-manager-api sendiri
 *   BOOTSTRAP_DEPLOY_USER  (opsional, default: $USER proses ini)
 *   BOOTSTRAP_PORT         (opsional, default: 4001)
 *   BOOTSTRAP_REPO_PATH    (opsional, default: cwd proses ini)
 */

const path = require('path');
const config = require('../src/config/config');
const database = require('../src/database/database');
const nginx = require('../src/nginx/nginx');
const ssl = require('../src/ssl/ssl');
const registry = require('../src/registry/registry');
const shell = require('../src/utils/shell');
const logger = require('../src/utils/logger');

async function main() {
  const domain = process.env.BOOTSTRAP_DOMAIN;
  const deployUser = process.env.BOOTSTRAP_DEPLOY_USER || process.env.USER;
  const port = parseInt(process.env.BOOTSTRAP_PORT || '4001', 10);
  const repoPath = process.env.BOOTSTRAP_REPO_PATH || process.cwd();

  if (!domain) {
    logger.error('BOOTSTRAP_DOMAIN wajib diisi (domain buat vps-manager-api sendiri, mis. api.zenlab.id). Contoh: BOOTSTRAP_DOMAIN=api.zenlab.id node bin/vps-bootstrap.js');
    process.exit(1);
  }
  if (!deployUser) {
    logger.error('Gagal deteksi deploy user (BOOTSTRAP_DEPLOY_USER kosong dan $USER juga kosong).');
    process.exit(1);
  }

  logger.title('vps-manager Bootstrap');
  logger.info(`Domain: ${domain} | Deploy user: ${deployUser} | Port: ${port} | Repo: ${repoPath}`);

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

  // 2/6 - API key
  logger.section('2/6 - Generate API Key');
  const existingHash = config.loadConfig().api?.key_hash;
  if (existingHash) {
    logger.warn(
      'API key sudah pernah di-generate sebelumnya - dilewatin (biar client lama yang masih pakai key itu gak ' +
      'langsung ke-reject). Jalankan "node bin/vps-api-keygen.js" manual kalau memang mau generate ulang.'
    );
  } else {
    const apiKey = config.generateApiKey();
    logger.card(
      'API KEY - SIMPAN SEKARANG, GAK BAKAL DITAMPILIN LAGI SETELAH INI',
      [apiKey, '', 'Pasang di app sebagai header:', `Authorization: Bearer ${apiKey}`],
      { color: 'red' }
    );
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
  if (startupCheck.ok && startupCheck.output.trim() === 'enabled') {
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
  if (ssl.checkCertExists(domain)) {
    logger.info(`Sertifikat SSL untuk "${domain}" udah ada - dilewatin.`);
  } else {
    const sslResult = ssl.issueCertificate(domain, []);
    if (!sslResult.ok) {
      logger.warn(
        `SSL gagal diterbitkan otomatis: ${sslResult.errorMessage}\n` +
        `Pastikan domain "${domain}" sudah diarahkan (DNS A record) ke IP VPS ini, lalu coba lagi lewat menu SSL Manager.`
      );
    } else {
      const upgradeResult = nginx.upgradeToSSL({ domain, port, fullchain: sslResult.fullchain, privkey: sslResult.privkey });
      upgradeResult.ok
        ? logger.success(`HTTPS aktif untuk "${domain}".`)
        : logger.warn(`SSL terbit tapi gagal upgrade Nginx ke HTTPS: ${upgradeResult.errorMessage}`);
    }
  }

  logger.title('Bootstrap Selesai');
  logger.card('Ringkasan', [
    `API URL   : https://${domain}`,
    `Deploy user: ${deployUser}`,
    `Repo path : ${repoPath}`,
    '',
    'Kalau API key ditampilkan di atas (step 2/6), SIMPAN SEKARANG - gak',
    'akan ditampilin lagi. Buka app, masukin domain + API key itu buat konek.',
  ]);
}

main().catch((err) => {
  logger.error(`Bootstrap gagal dengan error gak terduga: ${err.message}`);
  process.exit(1);
});
