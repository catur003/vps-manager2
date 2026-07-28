const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const inquirer = require('inquirer');
const logger = require('../utils/logger');
const registry = require('../registry/registry');
const config = require('../config/config');
const safety = require('../safety/safety');
const pm2 = require('../pm2/pm2');
const nginx = require('../nginx/nginx');
const git = require('../git/git');
const deployNew = require('../deploy/deployNew');
const ssl = require('../ssl/ssl');
const shell = require('../utils/shell');
const database = require('../database/database');
const dbRegistry = require('../registry/dbRegistry');
const build = require('../build/build');
const env = require('../project/env');
const deleteProject = require('../project/deleteProject');
const {
  NAME_REGEX,
  validateName,
  validateDomainOptional,
  validateDomainRequired,
  extractPortFromTarget,
  formatAlignedTable,
  levelColor,
  levelEmoji,
} = require('./helpers');
const { pickProjectPath, diskCard } = require('./uiHelpers');

const monitor = require('../monitor/monitor');
const backup = require('../backup/backup');
const security = require('../security/security');
const logviewer = require('../logviewer/logviewer');
const cleanup = require('../cleanup/cleanup');
const customMenu = require('../utils/customMenu');
const scanner = require('../scanner/scanner');

const MENU_ITEMS = [
  { key: '1', label: '📥 Import Project ke Registry (Bukan Deploy)', hint: 'Project SUDAH ada & SUDAH jalan di server (misal pindahan dari aaPanel) - fitur ini CUMA mendaftarkan ke registry tool ini biar kepilih di Git/PM2/Project/Backup Manager. Nginx, PM2, dan file project TIDAK disentuh sama sekali.' },
  { key: '2', label: '🚀 Deploy Project Baru', hint: 'Project BELUM ada - clone dari Git, install, build, jalanin di PM2, sampai (opsional) aktifin HTTPS, semua otomatis.' },
  { key: '3', label: '🔧 Git Manager', hint: 'Ambil update kode dari repo (pull), pindah branch, lihat histori commit.' },
  { key: '4', label: '📁 Project Manager (List/Edit/.env)', hint: 'Lihat/ubah file .env (variabel rahasia app: koneksi DB, API key, dll).' },
  { key: '5', label: '⚙️  PM2 Manager', hint: 'PM2 = program yang menjaga app Node kamu tetap nyala. Start/Stop/Restart/Logs app di sini.' },
  { key: '6', label: '🌐 Nginx Manager', hint: 'Nginx = pintu masuk web server, ngarahin domain ke port app kamu. Atur domain/reverse proxy di sini.' },
  { key: '7', label: '🔐 SSL Manager', hint: 'Aktifin/cek HTTPS (gembok hijau) untuk domain, via Let\'s Encrypt (certbot).' },
  { key: '8', label: '🔑 Permission Manager', hint: 'Cek apakah folder project dimiliki user yang benar (biar tidak ada masalah izin akses).' },
  { key: '9', label: '🗄️  Database Manager', hint: 'Lihat daftar database & isi tabel (read-only, aman untuk dicek-cek).' },
  { key: '10', label: '📊 Server Monitor', hint: 'Cek pemakaian CPU/RAM/Disk server saat ini.' },
  { key: '11', label: '💾 Backup Manager', hint: 'Backup/restore folder project atau database ke file arsip.' },
  { key: '12', label: '🔒 Security Manager', hint: 'Audit keamanan server: firewall, port terbuka, fail2ban, setting SSH (cuma cek, tidak mengubah apa-apa).' },
  { key: '13', label: '⚡ Configuration', hint: 'Setting default tool ini sendiri (deploy user, folder default, dll) - bukan setting project.' },
  { key: '14', label: '📜 Log Viewer', hint: 'Lihat log error app (PM2) atau log error domain (Nginx) buat nyari penyebab masalah.' },
  { key: '15', label: '🧹 Bersihin Cache/Storage', hint: 'Scan folder home sebuah user, cari cache/file regenerable (build cache, npm/yarn cache, log PM2) buat dihapus & hemat storage. Cuma di dalam $HOME user itu, ada blacklist folder sistem.' },
  { key: '16', label: '🔍 VPS Scanner', hint: 'Deteksi kondisi NYATA server dan bandingkan dengan registry. Baru ada "Cek Port" - fitur PM2/API/Registry match menyusul.' },
  { key: '0', label: '🚪 Exit', hint: 'Keluar dari tool ini.' },
];

async function showMainMenu() {
  const choice = await customMenu.showMenu('VPS MANAGER', MENU_ITEMS);

  switch (choice) {
    case '1':
      await deployOldMenu();
      break;
    case '2':
      await deployNewMenu();
      break;
    case '3':
      await gitManagerMenu();
      break;
    case '4':
      await projectManagerMenu();
      break;
    case '5':
      await pm2ManagerMenu();
      break;
    case '6':
      await nginxManagerMenu();
      break;
    case '7':
      await sslManagerMenu();
      break;
    case '8':
      await permissionManagerMenu();
      break;
    case '9':
      await databaseManagerMenu();
      break;
    case '10':
      await serverMonitorMenu();
      break;
    case '11':
      await backupManagerMenu();
      break;
    case '12':
      await securityManagerMenu();
      break;
    case '13':
      await configurationMenu();
      break;
    case '14':
      await logViewerMenu();
      break;
    case '15':
      await cleanupMenu();
      break;
    case '16':
      await vpsScannerMenu();
      break;
    case '0':
      logger.info('Sampai jumpa!');
      process.exit(0);
    default:
      logger.warn('Menu ini belum aktif di Phase 1. Cek roadmap di README.');
      await showMainMenu();
  }
}

async function projectManagerMenu() {
  const projects = registry.listProjects();

  if (projects.length === 0) {
    logger.warn('Belum ada project terdaftar. Deploy dulu lewat menu 2.');
    await afterAction(null);
    return;
  }

  const action = await customMenu.showMenu('📁 Project Manager', [
    { key: 'list', label: 'List Project', hint: 'Lihat semua project yang terdaftar di tool ini beserta domain & port-nya.' },
    { key: 'view-env', label: 'Lihat .env', hint: '.env = file berisi variabel rahasia app (koneksi database, API key, dll). Ini cuma lihat, tidak mengubah.' },
    { key: 'edit-env', label: 'Edit .env', hint: 'Ubah isi .env. Setelah simpan, tool akan otomatis nawarin Restart PM2 biar perubahan langsung kepakai.' },
    { key: 'delete-project', label: '🗑️  Delete Project', hint: 'Hapus project: PM2 app, site nginx, registry, dan opsional database & folder source code-nya sekaligus.' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await showMainMenu();
    return;
  }

  if (action === 'delete-project') {
    await deleteProjectFlow(projects);
    return;
  }

  if (action === 'list') {
    for (const p of projects) {
      if (fs.existsSync(p.path)) {
        logger.card(`📁 ${p.name}`, [`Type: ${p.type}`, `Domain: ${p.domain}`, `Port: ${p.port}`], {
          color: 'green',
        });
        continue;
      }

      logger.error(`📁 ${p.name} - folder "${p.path}" tidak ditemukan di disk.`);
      const { removeFromRegistry } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'removeFromRegistry',
          message: `Hapus "${p.name}" dari registry? (folder di disk TIDAK disentuh, ini cuma hapus catatannya)`,
          default: false,
        },
      ]);
      if (removeFromRegistry) {
        registry.removeProject(p.name);
        logger.success(`"${p.name}" dihapus dari registry.`);
      }
    }
    await afterAction(projectManagerMenu);
    return;
  }

  const { project } = await inquirer.prompt([
    {
      type: 'list',
      name: 'project',
      message: 'Pilih project:',
      choices: [...projects.map((p) => ({ name: p.name, value: p })), { name: '↩️  Kembali', value: 'back' }],
    },
  ]);
  if (project === 'back') {
    await projectManagerMenu();
    return;
  }
  const deployUser = project.deploy_user || config.loadConfig().deploy_user;

  if (action === 'view-env') {
    const { content } = env.readEnv(project.path, deployUser);
    logger.card(`.env - ${project.name}`, (content || '(.env belum ada)').split('\n'), { color: 'blue' });
  } else if (action === 'edit-env') {
    const { content: currentContent } = env.readEnv(project.path, deployUser);
    const { content } = await inquirer.prompt([
      {
        type: 'editor',
        name: 'content',
        message: 'Edit isi .env (simpan+keluar buat lanjut):',
        default: currentContent || '',
      },
    ]);

    const writeResult = env.writeEnv(project.path, deployUser, content);

    if (!writeResult.ok) {
      logger.error(writeResult.errorMessage);
      await afterAction(projectManagerMenu);
      return;
    }
    logger.success('.env berhasil disimpan.');

    const { restart } = await inquirer.prompt([
      { type: 'confirm', name: 'restart', message: `Restart PM2 "${project.name}" sekarang biar env baru kepake?`, default: true },
    ]);
    if (restart) {
      const restartResult = pm2.restart(project.name, deployUser);
      restartResult.ok
        ? logger.success(`"${project.name}" berhasil di-restart.`)
        : logger.error(restartResult.errorMessage);
    }
  }

  await afterAction(projectManagerMenu);
}

async function deleteProjectFlow(projects) {
  const { project } = await inquirer.prompt([
    {
      type: 'list',
      name: 'project',
      message: 'Pilih project yang mau DIHAPUS:',
      choices: [...projects.map((p) => ({ name: p.name, value: p })), { name: '↩️  Kembali', value: 'back' }],
    },
  ]);
  if (project === 'back') {
    await projectManagerMenu();
    return;
  }

  const preview = deleteProject.preview(project);

  // Ringkasan dampak SEBELUM tanya apapun lagi - biar user tau persis apa
  // yang bakal kena sebelum mutusin opsi mana yang mau diceklis.
  const summaryLines = [
    `PM2 App: ${preview.pm2App ? `ada (status: ${preview.pm2App.status || 'unknown'})` : 'tidak ditemukan di PM2'}`,
    `Nginx Site: ${
      !project.domain
        ? 'project ini tidak punya domain'
        : preview.nginxCheckFailed
        ? `⚠️  GAGAL DICEK (${preview.nginxCheckError || 'unknown error'}) - status sebenarnya tidak diketahui`
        : preview.nginxFile
        ? `ada (${preview.nginxFile})`
        : 'tidak ditemukan'
    }`,
    `Folder: ${preview.folderExists ? `ada (${project.path})` : 'tidak ditemukan di disk'}`,
    `Database terkait: ${preview.relatedDatabases.length > 0 ? preview.relatedDatabases.map((d) => d.dbName).join(', ') : 'tidak ada'}`,
  ];
  logger.card(`⚠️  Delete Project: ${project.name}`, summaryLines, { color: 'yellow' });

  const { confirmName } = await inquirer.prompt([
    {
      type: 'input',
      name: 'confirmName',
      message: `Ketik ulang nama project ("${project.name}") untuk konfirmasi, atau kosongkan buat batal:`,
    },
  ]);
  if (confirmName !== project.name) {
    logger.info('Dibatalkan (nama tidak cocok).');
    await afterAction(projectManagerMenu);
    return;
  }

  const checkboxChoices = [
    { name: 'Hapus PM2 App', value: 'deletePm2', checked: true },
  ];
  if (project.domain) checkboxChoices.push({ name: 'Hapus Nginx Site', value: 'deleteNginx', checked: true });
  if (preview.relatedDatabases.length > 0) {
    checkboxChoices.push({
      name: `DROP Database terkait (${preview.relatedDatabases.map((d) => d.dbName).join(', ')}) - data HILANG PERMANEN`,
      value: 'dropDatabases',
      checked: false, // default OFF, ini paling destruktif (data hilang, bukan cuma unlink)
    });
  }
  if (preview.folderExists) {
    checkboxChoices.push({
      name: `Hapus Folder Source Code (${project.path}) - HILANG PERMANEN`,
      value: 'deleteFolder',
      checked: false, // default OFF sesuai rekomendasi - jangan rm -rf tanpa diminta eksplisit
    });
  }

  const { selectedOptions } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedOptions',
      message: 'Pilih apa aja yang mau ikut dihapus (spasi = pilih, enter = lanjut):',
      choices: checkboxChoices,
    },
  ]);

  const opts = {
    deletePm2: selectedOptions.includes('deletePm2'),
    deleteNginx: selectedOptions.includes('deleteNginx'),
    dropDatabases: selectedOptions.includes('dropDatabases'),
    deleteFolder: selectedOptions.includes('deleteFolder'),
  };

  const { finalConfirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'finalConfirm',
      message: `YAKIN? Project "${project.name}" akan dihapus permanen dari registry${opts.deletePm2 ? ', PM2' : ''}${opts.deleteNginx ? ', Nginx' : ''}${opts.dropDatabases ? ', Database' : ''}${opts.deleteFolder ? ', dan Folder Source Code' : ''}. Tindakan ini tidak bisa di-undo.`,
      default: false,
    },
  ]);
  if (!finalConfirm) {
    logger.info('Dibatalkan.');
    await afterAction(projectManagerMenu);
    return;
  }

  const { results } = deleteProject.execute(project, opts);

  const resultLines = results.map((r) => `${r.ok ? '✔' : '✘'} ${r.step}: ${r.message}`);
  const anyFailed = results.some((r) => !r.ok);
  logger.card(
    anyFailed ? `⚠️  Delete Project selesai (ada yang gagal)` : `✅ Delete Project selesai`,
    resultLines,
    { color: anyFailed ? 'yellow' : 'green' }
  );

  await afterAction(projectManagerMenu);
}

async function permissionManagerMenu() {
  logger.section('Permission Manager');
  const projects = registry.listProjects();
  const cfg = config.loadConfig();

  if (projects.length === 0) {
    logger.warn('Belum ada project untuk dicek.');
    await afterAction(permissionManagerMenu);
    return;
  }

  const { name } = await inquirer.prompt([
    {
      type: 'list',
      name: 'name',
      message: 'Pilih project untuk cek permission:',
      choices: [...projects.map((p) => p.name), '↩️  Kembali'],
    },
  ]);
  if (name === '↩️  Kembali') {
    await showMainMenu();
    return;
  }

  const project = registry.findProject(name);
  const result = safety.checkPermission(project.path, cfg.deploy_user);
  result.pass ? logger.success(result.message) : logger.error(result.message);

  await afterAction(permissionManagerMenu);
}

async function configurationMenu() {
  logger.section('Configuration');
  const cfg = config.loadConfig();
  logger.card(
    'Konfigurasi Saat Ini',
    Object.entries(cfg).map(([k, v]) => {
      if (k === 'db_root_password') return `${k}: ${v ? '••••••••' : '(kosong)'}`;
      if (k === 'github_accounts') {
        const list = Array.isArray(v) ? v : [];
        return `${k}: ${list.length === 0 ? '(belum ada)' : list.map((a) => `${a.label} (${a.username})`).join(', ')}`;
      }
      return `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`;
    }),
    { color: 'blue' }
  );

  const { nextAction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'nextAction',
      message: 'Mau apa?',
      choices: [
        { name: 'Ubah konfigurasi umum', value: 'edit' },
        { name: '🔑 Kelola akun GitHub tersimpan (PAT)', value: 'github' },
        { name: '↩️  Kembali tanpa ubah', value: 'back' },
      ],
    },
  ]);

  if (nextAction === 'edit') {
    await configEditCategoryMenu();
    return;
  } else if (nextAction === 'github') {
    await githubAccountsMenu();
    return;
  }

  await afterAction(configurationMenu);
}

/**
 * Submenu kategori buat edit config. Dipecah per-kategori (bukan satu form
 * raksasa) karena config.json sekarang punya 15+ field - kalau digabung jadi
 * satu form prompt-berturut-turut bakal kepanjangan & gampang salah pencet di
 * layar HP. Tiap kategori nyimpen sendiri-sendiri terus balik ke sini lagi,
 * biar bisa ubah beberapa kategori berturut-turut tanpa ulang dari awal.
 */
async function configEditCategoryMenu() {
  const cfg = config.loadConfig();
  const { category } = await inquirer.prompt([
    {
      type: 'list',
      name: 'category',
      message: 'Kategori mana yang mau diubah?',
      choices: [
        { name: 'Deploy & Git (deploy_user, default_folder, git_branch, starting_port)', value: 'deploy' },
        { name: 'Nginx (nginx_user, nginx_binary, nginx_conf_dir, nginx_log_dir)', value: 'nginx' },
        { name: 'SSL / Certbot (certbot_webroot, certbot_email)', value: 'ssl' },
        { name: 'Database (db_root_user, db_root_password)', value: 'database' },
        { name: 'Backup (backup_dir, backup_retention_days)', value: 'backup' },
        { name: 'Runtime Default (node, php)', value: 'runtime' },
        { name: '↩️  Kembali', value: 'back' },
      ],
    },
  ]);

  if (category === 'back') {
    await configurationMenu();
    return;
  }

  if (category === 'deploy') {
    const { deploy_user, default_folder, git_branch, starting_port } = await inquirer.prompt([
      { type: 'input', name: 'deploy_user', message: 'Deploy user:', default: cfg.deploy_user },
      { type: 'input', name: 'default_folder', message: 'Default folder:', default: cfg.default_folder },
      { type: 'input', name: 'git_branch', message: 'Git branch default:', default: cfg.git_branch },
      { type: 'number', name: 'starting_port', message: 'Starting port:', default: cfg.starting_port },
    ]);
    config.saveConfig({ ...cfg, deploy_user, default_folder, git_branch, starting_port });
    logger.success('Konfigurasi Deploy & Git disimpan.');
  } else if (category === 'nginx') {
    logger.info(
      'nginx_binary & nginx_conf_dir beda-beda tergantung server: aaPanel biasanya ' +
      '/www/server/nginx/sbin/nginx & /www/server/panel/vhost/nginx, sedangkan Ubuntu/Debian ' +
      'nginx bawaan apt biasanya /usr/sbin/nginx & /etc/nginx/sites-available. Cek dulu kalau ragu: ' +
      '"which nginx" dan "ls /etc/nginx" lewat menu Buka Terminal.'
    );
    const { nginx_user, nginx_binary, nginx_conf_dir, nginx_log_dir } = await inquirer.prompt([
      { type: 'input', name: 'nginx_user', message: 'Nginx user:', default: cfg.nginx_user },
      { type: 'input', name: 'nginx_binary', message: 'Path binary nginx:', default: cfg.nginx_binary },
      { type: 'input', name: 'nginx_conf_dir', message: 'Folder config vhost nginx:', default: cfg.nginx_conf_dir },
      { type: 'input', name: 'nginx_log_dir', message: 'Folder log nginx:', default: cfg.nginx_log_dir },
    ]);
    config.saveConfig({ ...cfg, nginx_user, nginx_binary, nginx_conf_dir, nginx_log_dir });
    logger.success('Konfigurasi Nginx disimpan.');
  } else if (category === 'ssl') {
    const { certbot_webroot, certbot_email } = await inquirer.prompt([
      { type: 'input', name: 'certbot_webroot', message: 'Certbot webroot:', default: cfg.certbot_webroot },
      { type: 'input', name: 'certbot_email', message: 'Email certbot (buat notifikasi expiry):', default: cfg.certbot_email },
    ]);
    config.saveConfig({ ...cfg, certbot_webroot, certbot_email });
    logger.success('Konfigurasi SSL/Certbot disimpan.');
  } else if (category === 'database') {
    logger.info(
      'Kalau MySQL/MariaDB root-nya pakai auth_socket (nggak bisa login password), pakai menu ' +
      '"Setup User Admin DB (fix auth_socket)" di Database Manager - itu otomatis tes koneksi dulu ' +
      'sebelum simpan ke sini. Ubah manual di sini cuma kalau kamu yakin user/password-nya valid.'
    );
    const { db_root_user, changePassword } = await inquirer.prompt([
      { type: 'input', name: 'db_root_user', message: 'Database root user:', default: cfg.db_root_user },
      { type: 'confirm', name: 'changePassword', message: 'Ganti password juga?', default: false },
    ]);
    let db_root_password = cfg.db_root_password;
    if (changePassword) {
      const { password } = await inquirer.prompt([
        { type: 'password', name: 'password', mask: '*', message: 'Password baru:' },
      ]);
      db_root_password = password;
    }
    config.saveConfig({ ...cfg, db_root_user, db_root_password });
    logger.success('Konfigurasi Database disimpan.');
  } else if (category === 'backup') {
    const { backup_dir, backup_retention_days } = await inquirer.prompt([
      { type: 'input', name: 'backup_dir', message: 'Folder backup:', default: cfg.backup_dir },
      { type: 'number', name: 'backup_retention_days', message: 'Retensi backup (hari):', default: cfg.backup_retention_days },
    ]);
    config.saveConfig({ ...cfg, backup_dir, backup_retention_days });
    logger.success('Konfigurasi Backup disimpan.');
  } else if (category === 'runtime') {
    const runtimeDefault = cfg.runtime_default || {};
    const { node, php } = await inquirer.prompt([
      { type: 'input', name: 'node', message: 'Versi Node.js default:', default: runtimeDefault.node },
      { type: 'input', name: 'php', message: 'Versi PHP default:', default: runtimeDefault.php },
    ]);
    config.saveConfig({ ...cfg, runtime_default: { ...runtimeDefault, node, php } });
    logger.success('Konfigurasi Runtime Default disimpan.');
  }

  await configEditCategoryMenu();
}

/**
 * Kelola akun GitHub tersimpan (label, username, Personal Access Token).
 * Dipakai di Deploy Project Baru & Git Manager biar nggak perlu ngetik ulang
 * username/token tiap mau clone/update remote repo private.
 */
async function githubAccountsMenu() {
  logger.section('Akun GitHub Tersimpan');
  const accounts = config.listGithubAccounts();

  if (accounts.length === 0) {
    logger.info('Belum ada akun GitHub yang disimpan.');
  } else {
    accounts.forEach((a) => {
      const masked = a.token ? `${a.token.slice(0, 4)}${'•'.repeat(Math.max(0, a.token.length - 8))}${a.token.slice(-4)}` : '(kosong)';
      logger.card(a.label, [`Username: ${a.username}`, `Token: ${masked}`], { color: 'blue' });
    });
  }

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'Mau apa?',
      choices: [
        { name: '➕ Tambah akun baru', value: 'add' },
        ...(accounts.length > 0 ? [{ name: '🗑️  Hapus akun', value: 'remove' }] : []),
        { name: '↩️  Kembali', value: 'back' },
      ],
    },
  ]);

  if (action === 'back') {
    await configurationMenu();
    return;
  }

  if (action === 'add') {
    const { label, username, token } = await inquirer.prompt([
      { type: 'input', name: 'label', message: 'Nama/label akun (buat identifikasi, mis. "akun-pribadi"):', validate: (v) => (v.trim() ? true : 'Nggak boleh kosong') },
      { type: 'input', name: 'username', message: 'Username GitHub:', validate: (v) => (v.trim() ? true : 'Nggak boleh kosong') },
      {
        type: 'password',
        name: 'token',
        mask: '*',
        message: 'Personal Access Token (PAT, scope "repo" cukup):',
        validate: (v) => (v.trim() ? true : 'Nggak boleh kosong'),
      },
    ]);
    config.addGithubAccount({ label: label.trim(), username: username.trim(), token: token.trim() });
    logger.success(`Akun "${label}" tersimpan.`);
  } else if (action === 'remove') {
    const { label } = await inquirer.prompt([
      {
        type: 'list',
        name: 'label',
        message: 'Hapus akun yang mana?',
        choices: [
          ...accounts.map((a) => ({ name: `${a.label} (${a.username})`, value: a.label })),
          { name: '↩️  Batal', value: 'back' },
        ],
      },
    ]);
    if (label === 'back') {
      await afterAction(githubAccountsMenu);
      return;
    }
    config.removeGithubAccount(label);
    logger.success(`Akun "${label}" dihapus dari config. (Repo yang sudah ke-clone pakai token ini TIDAK ikut ke-update - remote-nya masih pakai token lama sampai kamu update manual lewat Git Manager kalau perlu.)`);
  }

  await afterAction(githubAccountsMenu);
}

async function pm2ManagerMenu() {
  const action = await customMenu.showMenu('⚙️  PM2 Manager', [
    { key: 'list', label: 'List Application', hint: 'Lihat semua app yang lagi jalan di PM2 (status, port, CPU/RAM, uptime).' },
    { key: 'start', label: 'Start', hint: 'Nyalain app yang lagi berhenti (status "stopped").' },
    { key: 'stop', label: 'Stop', hint: 'Matiin app. Domainnya jadi error/down sampai di-Start lagi.' },
    { key: 'restart', label: 'Restart (apply perubahan .env/kode)', hint: 'Matiin lalu nyalain ulang app. PAKAI INI kalau abis ubah .env atau ada kode baru (git pull) biar perubahannya kepakai.' },
    { key: 'logs', label: 'Logs', hint: 'Lihat output/error terakhir dari app - buat nyari penyebab kalau app crash atau error.' },
    { key: 'delete', label: 'Delete', hint: 'Hapus app dari daftar PM2 sepenuhnya (bukan cuma stop). File project TIDAK ikut terhapus.' },
    { key: 'detail', label: 'Detail Status', hint: 'Info teknis lengkap 1 app: path, mode, restart count, dll.' },
    { key: 'save', label: 'Simpan Daftar Auto-Start (Save)', hint: 'BUKAN buat apply perubahan config! Ini cuma nyimpen daftar app biar otomatis nyala lagi kalau server di-reboot.' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await showMainMenu();
    return;
  }

  if (action === 'save') {
    const users = pm2.getRelevantUsers();
    users.forEach((user) => {
      const result = pm2.saveStartup(user);
      result.ok
        ? logger.success(`PM2 startup list disimpan untuk user "${user}".`)
        : logger.error(`User "${user}": ${result.errorMessage}`);
    });
    await afterAction(pm2ManagerMenu);
    return;
  }

  if (action === 'list') {
    const { ok, apps, error, warnings } = pm2.listApps();
    if (!ok) {
      logger.error(error || 'Gagal mengambil daftar PM2. Pastikan PM2 terinstall.');
    } else if (apps.length === 0) {
      logger.warn('Belum ada aplikasi yang jalan di PM2.');
    } else {
      apps.forEach((app) => {
        logger.card(
          `${app.name}  [${app.status}]`,
          [`Owner: ${app.owner}`, `Port: ${app.port}`, `CPU: ${app.cpu}  RAM: ${app.ram}`, `Uptime: ${app.uptime}`],
          { color: app.status === 'online' ? 'green' : 'red' }
        );
      });
      if (warnings && warnings.length > 0) {
        warnings.forEach((w) => logger.warn(w));
      }
    }
    await afterAction(pm2ManagerMenu);
    return;
  }

  // Aksi yang butuh nama app: start, stop, restart, logs, delete, detail
  // "start" pakai varian yang juga nyertain project terdaftar yang belum
  // pernah nyala di PM2 sama sekali (lihat listAppsIncludingUnstarted).
  const { ok, apps } = action === 'start' ? pm2.listAppsIncludingUnstarted() : pm2.listApps();
  if (!ok || apps.length === 0) {
    logger.warn(
      action === 'start'
        ? 'Belum ada aplikasi PM2 atau project terdaftar untuk di-start. Daftarkan dulu lewat menu Deploy, atau pastikan registry-nya berisi path & port yang benar.'
        : 'Belum ada aplikasi PM2 untuk dipilih.'
    );
    await afterAction(pm2ManagerMenu);
    return;
  }

  const { selected } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selected',
      message: 'Pilih aplikasi:',
      choices: apps.map((a) => ({ name: `${a.name} (${a.owner})`, value: `${a.name}|${a.owner}` })),
    },
  ]);
  const [name, owner] = selected.split('|');

  let result;
  switch (action) {
    case 'start':
      result = pm2.start(name, owner);
      break;
    case 'stop':
      result = pm2.stop(name, owner);
      break;
    case 'restart':
      result = pm2.restart(name, owner);
      break;
    case 'delete':
      result = pm2.deleteApp(name, owner);
      break;
    case 'logs':
      result = pm2.logs(name, owner);
      break;
    case 'detail':
      result = pm2.detail(name, owner);
      break;
  }

  if (result.ok) {
    if (action === 'logs' || action === 'detail') {
      logger.card(`📄 ${action === 'logs' ? 'Logs' : 'Detail'}: ${name}`, result.output.split('\n'), { color: 'blue' });
    } else logger.success(`Aksi "${action}" untuk "${name}" berhasil.`);
  } else {
    logger.error(result.errorMessage || 'Aksi gagal.');
  }

  await afterAction(pm2ManagerMenu);
}

async function nginxManagerMenu() {
  const action = await customMenu.showMenu('🌐 Nginx Manager', [
    { key: 'list', label: 'List Site', hint: 'Lihat semua domain yang terdaftar dan kemana dia diarahkan (port app / folder statis).' },
    { key: 'view', label: 'View Config', hint: 'Lihat isi file config nginx mentah untuk 1 domain.' },
    { key: 'add', label: 'Tambah Site Baru (Reverse Proxy)', hint: 'Daftarin domain baru yang diarahkan ke port app Node kamu. Nginx otomatis di-reload setelah ini.' },
    { key: 'delete', label: 'Hapus Site', hint: 'Hapus domain dari nginx (config di-backup dulu otomatis). App PM2-nya TIDAK ikut dihapus/dimatikan.' },
    { key: 'test', label: 'Test Config', hint: 'Cek syntax semua config nginx valid atau tidak - TANPA benar-benar apply/reload. Aman dijalankan kapan saja.' },
    { key: 'reload', label: 'Reload Nginx (apply perubahan domain)', hint: 'Baca ulang semua config domain biar perubahan kepakai, TANPA mutusin koneksi yang lagi jalan. Ini bukan buat app Node - itu urusannya PM2 Restart.' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await showMainMenu();
    return;
  }

  if (action === 'test') {
    const result = nginx.testConfig();
    result.ok ? logger.success('Config nginx valid.') : logger.error(result.errorMessage);
    await afterAction(nginxManagerMenu);
    return;
  }

  if (action === 'reload') {
    const result = nginx.reload();
    result.ok ? logger.success('Nginx berhasil di-reload.') : logger.error(result.errorMessage);
    await afterAction(nginxManagerMenu);
    return;
  }

  if (action === 'add') {
    const { domain, port } = await inquirer.prompt([
      { type: 'input', name: 'domain', message: 'Domain (contoh: app.example.com):', validate: validateDomainRequired },
      { type: 'number', name: 'port', message: 'Port aplikasi (contoh: 3000):' },
    ]);

    logger.card('Konfirmasi Tambah Site', [`Domain: ${domain}`, `Port: ${port}`], { color: 'yellow' });
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: 'Buat site ini sekarang?', default: false },
    ]);
    if (!confirm) {
      logger.info('Dibatalkan.');
      await afterAction(nginxManagerMenu);
      return;
    }

    const result = nginx.createReverseProxySite({ domain, port });
    result.ok
      ? logger.success(`Site "${domain}" berhasil dibuat dan nginx sudah di-reload.`)
      : logger.error(result.errorMessage);
    await afterAction(nginxManagerMenu);
    return;
  }

  // Aksi yang butuh pilih site: list, view, delete
  const { ok, sites, error } = nginx.listSites();
  if (!ok) {
    logger.error(error || 'Gagal membaca folder config nginx.');
    await afterAction(nginxManagerMenu);
    return;
  }
  if (sites.length === 0) {
    logger.warn('Belum ada site terdaftar di folder config nginx.');
    await afterAction(nginxManagerMenu);
    return;
  }

  if (action === 'list') {
    sites.forEach((s) => {
      logger.card(s.domain, [s.target, `File: ${s.file}`], { color: 'cyan' });
    });
    await afterAction(nginxManagerMenu);
    return;
  }

  const { file } = await inquirer.prompt([
    {
      type: 'list',
      name: 'file',
      message: 'Pilih site:',
      choices: sites.map((s) => ({ name: `${s.domain} (${s.file})`, value: s.file })),
    },
  ]);

  if (action === 'view') {
    const result = nginx.viewSite(file);
    result.ok
      ? logger.card(`📄 Config: ${file}`, result.output.split('\n'), { color: 'cyan' })
      : logger.error(result.errorMessage);
  } else if (action === 'delete') {
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: `Yakin hapus site "${file}"? (sudah di-backup otomatis)`, default: false },
    ]);
    if (confirm) {
      const result = nginx.deleteSite(file);
      result.ok ? logger.success(`Site "${file}" dihapus dan nginx sudah di-reload.`) : logger.error(result.errorMessage);
    } else {
      logger.info('Dibatalkan.');
    }
  }

  await afterAction(nginxManagerMenu);
}



/**
 * Wizard setelah kode berubah (pull/checkout). Next.js (apalagi + Prisma)
 * jalan dari HASIL BUILD, bukan source code mentah - jadi cuma restart PM2
 * doang seringkali nggak cukup, kode barunya belum kepakai. Urutan yang
 * ditawarin di sini: npm install (kalau package.json berubah) -> prisma
 * generate/push (kalau Prisma dipakai) -> npm run build -> baru restart PM2.
 * Tiap langkah tetap tanya dulu (bukan otomatis semua), defaultnya aja yang
 * disesuaikan dari file yang kedeteksi berubah.
 */
async function offerUpdateFlow(projectPath, projectName, deployUser, changedFiles = []) {
  const pkgChanged = changedFiles.some((f) => f === 'package.json' || f === 'package-lock.json');
  const prismaChanged = changedFiles.some((f) => f.startsWith('prisma/'));

  const { runWizard } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'runWizard',
      message: 'Kode barusan berubah. Cek & jalanin langkah update (install/build/restart) sekarang?',
      default: true,
    },
  ]);
  if (!runWizard) {
    logger.warn('Dilewati. Inget: kalau ada dependency/schema baru atau butuh build ulang, app bisa error/pakai kode lama sampai langkah itu dijalanin manual.');
    return;
  }

  // 1. npm install
  if (build.hasPackageJson(projectPath, deployUser)) {
    const { doInstall } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'doInstall',
        message: pkgChanged
          ? '📦 package.json ikut berubah di update ini. Jalankan "npm install"?'
          : '📦 Jalankan "npm install"? (aman di-skip kalau yakin nggak ada dependency baru)',
        default: pkgChanged,
      },
    ]);
    if (doInstall) {
      logger.info('⏳ npm install... (bisa agak lama)');
      const r = build.npmInstall(projectPath, deployUser);
      r.ok ? logger.success('npm install selesai.') : logger.error('npm install GAGAL:\n' + r.errorMessage);
    }
  }

  // 2. Prisma (generate + sync schema ke DB)
  if (build.hasPrismaSchema(projectPath, deployUser)) {
    logger.info('🔷 Prisma terdeteksi di project ini (ada prisma/schema.prisma).');
    const { doGenerate } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'doGenerate',
        message: 'Jalankan "npx prisma generate"? (regenerate Prisma Client - wajib kalau schema berubah atau abis npm install)',
        default: true,
      },
    ]);
    if (doGenerate) {
      logger.info('⏳ prisma generate...');
      const r = build.prismaGenerate(projectPath, deployUser);
      r.ok ? logger.success('Prisma generate selesai.') : logger.error('Prisma generate GAGAL:\n' + r.errorMessage);
    }

    const { syncMode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'syncMode',
        message: 'Sinkronkan struktur tabel database ke schema terbaru?',
        choices: [
          { name: 'Skip (struktur tabel nggak berubah)', value: 'skip' },
          { name: 'DB Push - cepat, TANPA histori migrasi (cocok dev/project kecil)', value: 'push' },
          { name: 'Migrate Deploy - pakai file migrasi resmi (disarankan untuk production)', value: 'migrate' },
        ],
        default: prismaChanged ? 1 : 0,
      },
    ]);
    if (syncMode === 'push') {
      logger.info('⏳ prisma db push...');
      const r = build.prismaDbPush(projectPath, deployUser);
      r.ok ? logger.success('DB push selesai.') : logger.error('DB push GAGAL:\n' + r.errorMessage);
    } else if (syncMode === 'migrate') {
      logger.info('⏳ prisma migrate deploy...');
      const r = build.prismaMigrateDeploy(projectPath, deployUser);
      r.ok ? logger.success('Migrate deploy selesai.') : logger.error('Migrate deploy GAGAL:\n' + r.errorMessage);
    }
  }

  // 3. Build (Next.js production build)
  const { doBuild } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'doBuild',
      message: '🏗️  Jalankan "npm run build"? (kalau project ini Next.js, ini WAJIB biar kode terbaru kepakai - restart doang nggak cukup)',
      default: true,
    },
  ]);
  if (doBuild) {
    logger.info('⏳ npm run build... (bisa beberapa menit, mohon tunggu)');
    const r = build.npmBuild(projectPath, deployUser);
    if (r.ok) {
      logger.success('Build selesai.');
    } else {
      logger.error('Build GAGAL:\n' + r.errorMessage);
      logger.warn('App LAMA masih tetap jalan aman (belum kesentuh). Perbaiki error di atas dulu sebelum restart, supaya nggak restart ke versi setengah jadi.');
      const { restartAnyway } = await inquirer.prompt([
        { type: 'confirm', name: 'restartAnyway', message: 'Build gagal - tetap mau lanjut ke Restart PM2?', default: false },
      ]);
      if (!restartAnyway) return;
    }
  }

  // 4. Restart PM2 (final step biar semua di atas kepakai)
  await offerRestartAfterCodeChange(projectName, deployUser);
}

/**
 * Tawarin restart PM2 setelah aksi yang mengubah kode di disk (pull/checkout),
 * biar user nggak lupa/bingung app-nya harus di-restart manual biar kepakai.
 * Cuma ditawarin kalau project-nya kenal (terdaftar di registry), soalnya
 * cuma dari situ kita tau nama app PM2-nya.
 */
async function offerRestartAfterCodeChange(projectName, deployUser) {
  if (!projectName) {
    logger.info('Project ini di-input manual (tidak terdaftar), jadi nama app PM2-nya tidak diketahui. Restart manual lewat PM2 Manager kalau perlu.');
    return;
  }
  const { restart } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'restart',
      message: `Restart PM2 "${projectName}" sekarang biar semua perubahan di atas kepakai?`,
      default: true,
    },
  ]);
  if (!restart) return;
  const restartResult = pm2.restart(projectName, deployUser);
  restartResult.ok
    ? logger.success(`"${projectName}" berhasil di-restart.`)
    : logger.error(`Gagal restart: ${restartResult.errorMessage}`);
}

async function gitManagerMenu() {
  const action = await customMenu.showMenu('🔧 Git Manager', [
    { key: 'status', label: 'Status', hint: 'Cek branch aktif & apakah ada perubahan file yang belum di-commit.' },
    { key: 'pull', label: 'Pull (ambil update kode)', hint: 'Tarik commit terbaru dari repo Git. Abis ini bakal ditawarin wizard install/build/restart otomatis.' },
    { key: 'branches', label: 'List Branch', hint: 'Lihat semua branch yang tersedia di repo ini.' },
    { key: 'checkout', label: 'Checkout Branch (pindah branch)', hint: 'Ganti kode project ke branch lain. Abis ini juga ditawarin wizard install/build/restart.' },
    { key: 'log', label: 'Log (10 commit terakhir)', hint: 'Lihat histori 10 commit terakhir di branch aktif.' },
    { key: 'stash', label: 'Stash (simpan sementara perubahan)', hint: 'Simpan perubahan lokal yang belum di-commit biar folder "bersih" lagi - dipakai kalau mau Pull tapi ada perubahan bentrok. Perubahan tidak hilang, cuma disimpan di gudang git.' },
    { key: 'credentials', label: '🔑 Update Kredensial GitHub (repo private)', hint: 'Ganti username/token yang dipakai buat Pull - dipakai kalau PAT lama expired/direvoke, atau mau pindah akun GitHub buat repo ini.' },
    { key: 'build', label: '🏗️  Install/Build/Restart Manual', hint: 'Jalankan wizard npm install + prisma + build + restart TANPA pull dulu - dipakai kalau kode udah kepull tapi belum sempet build, atau abis edit manual.' },
    { key: 'seed', label: '🌱 Jalankan Seed (Setup Akun Awal)', hint: 'Buat data awal (mis. akun admin pertama) via "prisma db seed". CUMA buat SEKALI di awal - jangan dijalanin ulang tiap update, resiko duplikat/reset data.' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await showMainMenu();
    return;
  }

  const { path: projectPath, deployUser, projectName } = await pickProjectPath();

  if (action === 'build') {
    await offerUpdateFlow(projectPath, projectName, deployUser, []);
    await afterAction(gitManagerMenu);
    return;
  }

  if (action === 'credentials') {
    const savedAccounts = config.listGithubAccounts();
    const currentUrl = git.getRemoteUrl(projectPath, deployUser) || '(tidak diketahui)';
    logger.info(`Remote saat ini: ${currentUrl}`);

    let account = null;
    let newBaseUrl = currentUrl !== '(tidak diketahui)' ? currentUrl : '';
    if (savedAccounts.length > 0) {
      const { accountLabel } = await inquirer.prompt([
        {
          type: 'list',
          name: 'accountLabel',
          message: 'Pakai akun GitHub tersimpan yang mana?',
          choices: [
            ...savedAccounts.map((a) => ({ name: `${a.label} (${a.username})`, value: a.label })),
            { name: 'Isi manual (token langsung di URL)', value: null },
          ],
        },
      ]);
      account = savedAccounts.find((a) => a.label === accountLabel) || null;
    }

    if (!account) {
      const { manualUrl } = await inquirer.prompt([
        { type: 'input', name: 'manualUrl', message: 'URL repo baru (boleh sertakan token: https://user:token@github.com/...):', default: newBaseUrl },
      ]);
      newBaseUrl = manualUrl;
      const setResult = git.setRemoteUrl(projectPath, newBaseUrl, deployUser);
      setResult.ok ? logger.success('Remote origin berhasil diupdate.') : logger.error(setResult.errorMessage);
    } else {
      const { repoUrl } = await inquirer.prompt([
        { type: 'input', name: 'repoUrl', message: 'URL repo (tanpa token, cukup https://github.com/owner/repo.git):', default: newBaseUrl },
      ]);
      const authedUrl = git.buildAuthenticatedUrl(repoUrl, account);
      const setResult = git.setRemoteUrl(projectPath, authedUrl, deployUser);
      setResult.ok ? logger.success(`Remote origin berhasil diupdate pakai akun "${account.label}".`) : logger.error(setResult.errorMessage);
    }

    await afterAction(gitManagerMenu);
    return;
  }

  if (action === 'seed') {
    if (!build.hasPrismaSchema(projectPath, deployUser)) {
      logger.warn('Tidak terdeteksi prisma/schema.prisma di project ini. Prisma seed kemungkinan besar nggak akan jalan.');
      const { proceedAnyway } = await inquirer.prompt([
        { type: 'confirm', name: 'proceedAnyway', message: 'Tetap coba jalankan "npx prisma db seed"?', default: false },
      ]);
      if (!proceedAnyway) {
        logger.info('Dibatalkan.');
        await afterAction(gitManagerMenu);
        return;
      }
    }
    logger.card(
      '⚠️  Konfirmasi Seed',
      [
        'Seed biasanya bikin data AWAL (mis. akun login pertama).',
        'Kalau database SUDAH ada isinya, ini bisa bikin data duplikat',
        'atau nge-reset sesuatu ke default, tergantung isi script seed-nya.',
        'Cuma jalankan ini kalau kamu YAKIN ini setup pertama kali.',
      ],
      { color: 'yellow' }
    );
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: 'Lanjut jalankan seed sekarang?', default: false },
    ]);
    if (!confirm) {
      logger.info('Dibatalkan.');
      await afterAction(gitManagerMenu);
      return;
    }
    logger.info('⏳ npx prisma db seed...');
    const result = build.prismaSeed(projectPath, deployUser);
    result.ok
      ? logger.success('Seed selesai. Cek akun/data awalnya sesuai isi script seed project ini.')
      : logger.error('Seed GAGAL:\n' + result.errorMessage);
    await afterAction(gitManagerMenu);
    return;
  }

  if (action === 'status') {
    const result = git.status(projectPath, deployUser);
    if (!result.ok) {
      logger.error(result.errorMessage);
    } else {
      logger.card(
        `Branch: ${result.branch}`,
        [
          result.remoteCheckFailed
            ? 'Ahead/Behind: tidak bisa dicek (git fetch ke remote gagal - repo private tanpa kredensial? cek koneksi/kredensial di menu "Update Kredensial GitHub")'
            : `Ahead: ${result.ahead}  Behind: ${result.behind}`,
          result.isClean ? 'Status: bersih (tidak ada perubahan)' : `Status: ada ${result.changedFiles.length} file berubah`,
          ...result.changedFiles.slice(0, 10),
        ],
        { color: result.isClean ? 'green' : 'yellow' }
      );
    }
  } else if (action === 'pull') {
    const check = git.status(projectPath, deployUser);
    if (check.ok && !check.isClean) {
      const { proceed } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'proceed',
          message: 'Ada perubahan belum di-commit di folder ini. Tetap pull? (bisa konflik)',
          default: false,
        },
      ]);
      if (!proceed) {
        logger.info('Dibatalkan.');
        await afterAction(gitManagerMenu);
        return;
      }
    }
    const savedAccounts = config.listGithubAccounts();
    const pullAccount = savedAccounts.length === 1 ? savedAccounts[0] : null; // kalau >1, biarin git nanya (ambigu akun mana)
    const beforeHead = git.getHead(projectPath, deployUser);
    const result = git.pull(projectPath, deployUser, pullAccount);
    result.ok ? logger.success('Pull berhasil.\n' + result.output) : logger.error(result.errorMessage);
    if (result.ok) {
      const afterHead = git.getHead(projectPath, deployUser);
      if (beforeHead && afterHead && beforeHead === afterHead) {
        logger.info('Nggak ada commit baru (sudah paling update). Wizard install/build/restart dilewati.');
      } else {
        const changedFiles = git.diffNameOnly(projectPath, beforeHead, afterHead, deployUser);
        await offerUpdateFlow(projectPath, projectName, deployUser, changedFiles);
      }
    }
  } else if (action === 'branches') {
    const result = git.listBranches(projectPath, deployUser);
    result.ok
      ? logger.card('Daftar Branch', result.branches, { color: 'cyan' })
      : logger.error(result.error);
  } else if (action === 'checkout') {
    const branchResult = git.listBranches(projectPath, deployUser);
    if (!branchResult.ok || branchResult.branches.length === 0) {
      logger.warn('Tidak ada branch ditemukan.');
      await afterAction(gitManagerMenu);
      return;
    }
    const { branch } = await inquirer.prompt([
      { type: 'list', name: 'branch', message: 'Checkout ke branch:', choices: branchResult.branches },
    ]);
    const beforeHead = git.getHead(projectPath, deployUser);
    const result = git.checkout(projectPath, branch, deployUser);
    result.ok ? logger.success(`Berhasil checkout ke "${branch}".`) : logger.error(result.errorMessage);
    if (result.ok) {
      const afterHead = git.getHead(projectPath, deployUser);
      if (beforeHead && afterHead && beforeHead === afterHead) {
        logger.info('Branch ini HEAD-nya sama kayak sebelumnya. Wizard install/build/restart dilewati.');
      } else {
        const changedFiles = git.diffNameOnly(projectPath, beforeHead, afterHead, deployUser);
        await offerUpdateFlow(projectPath, projectName, deployUser, changedFiles);
      }
    }
  } else if (action === 'log') {
    const result = git.log(projectPath, deployUser);
    result.ok ? logger.card('10 Commit Terakhir', result.output.split('\n'), { color: 'blue' }) : logger.error(result.errorMessage);
  } else if (action === 'stash') {
    const result = git.stash(projectPath, deployUser);
    result.ok ? logger.success('Perubahan berhasil di-stash.\n' + result.output) : logger.error(result.errorMessage);
  }

  await afterAction(gitManagerMenu);
}

async function deployNewMenu() {
  logger.section('Deploy Project Baru (Next.js)');
  const cfg = config.loadConfig();

  const savedAccounts = config.listGithubAccounts();
  let gitAccount = null;
  if (savedAccounts.length > 0) {
    const { accountLabel } = await inquirer.prompt([
      {
        type: 'list',
        name: 'accountLabel',
        message: 'Repo private? Pilih akun GitHub tersimpan (atau isi manual kalau publik):',
        choices: [
          ...savedAccounts.map((a) => ({ name: `${a.label} (${a.username})`, value: a.label })),
          { name: 'Publik / isi manual (nggak pakai akun tersimpan)', value: null },
        ],
      },
    ]);
    gitAccount = savedAccounts.find((a) => a.label === accountLabel) || null;
  }

  const { name, gitRepo, branch, domain } = await inquirer.prompt([
    { type: 'input', name: 'name', message: 'Nama project (unik, tanpa spasi):', validate: validateName },
    { type: 'input', name: 'gitRepo', message: 'URL Git repo (https://github.com/owner/repo.git):' },
    { type: 'input', name: 'branch', message: 'Branch:', default: cfg.git_branch },
    { type: 'input', name: 'domain', message: 'Domain (contoh: app.example.com):', validate: validateDomainRequired },
  ]);
  const cloneUrl = gitAccount ? git.buildAuthenticatedUrl(gitRepo, gitAccount) : gitRepo;

  const suggestedPort = safety.findFreePort(cfg.starting_port);
  const { port, folderPath, deployUser } = await inquirer.prompt([
    { type: 'number', name: 'port', message: 'Port aplikasi:', default: suggestedPort },
    {
      type: 'input',
      name: 'folderPath',
      message: 'Folder tujuan:',
      default: path.join(cfg.default_folder, name),
    },
    { type: 'input', name: 'deployUser', message: 'Deploy user:', default: cfg.deploy_user },
  ]);

  const { usePrisma } = await inquirer.prompt([
    { type: 'confirm', name: 'usePrisma', message: 'Project ini pakai Prisma?', default: false },
  ]);

  let prismaMode = 'none';
  let autoDatabaseUrl = '';
  if (usePrisma) {
    const { mode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'Pilih aksi Prisma sebelum build:',
        choices: [
          { name: 'Generate saja (nggak ubah database)', value: 'generate' },
          { name: 'DB Push (sinkron schema ke DB, tanpa histori migrasi)', value: 'push' },
          { name: 'Migrate Deploy (jalanin migrasi yang sudah ada)', value: 'migrate' },
        ],
      },
    ]);
    prismaMode = mode;

    const knownDbs = dbRegistry.listEntries();
    const { dbSetup } = await inquirer.prompt([
      {
        type: 'list',
        name: 'dbSetup',
        message: 'Database Setup:',
        choices: [
          ...(knownDbs.length > 0 ? [{ name: 'Gunakan database existing (sudah tercatat)', value: 'existing' }] : []),
          { name: 'Buat database baru', value: 'new' },
          { name: 'Lewati (isi DATABASE_URL manual nanti)', value: 'skip' },
        ],
      },
    ]);

    if (dbSetup === 'existing') {
      const { picked } = await inquirer.prompt([
        {
          type: 'list',
          name: 'picked',
          message: 'Pilih database:',
          choices: [
            ...knownDbs.map((e) => ({
              name: `${e.dbName}${e.usedByProject ? '  (sudah dipakai project: ' + e.usedByProject + ')' : ''}`,
              value: e.dbName,
            })),
            { name: '↩️  Kembali', value: '__back__' },
          ],
        },
      ]);
      if (picked === '__back__') {
        await deployNewMenu();
        return;
      }
      const existingEntry = dbRegistry.findByName(picked);
      autoDatabaseUrl = existingEntry.connectionUrl;
      // Tandai db ini dipakai project ini (kalau belum ditandai sebelumnya)
      if (!existingEntry.usedByProject) {
        dbRegistry.upsertEntry({ ...existingEntry, usedByProject: name });
      }
    } else if (dbSetup === 'new') {
      const { newDbName, newDbUser } = await inquirer.prompt([
        { type: 'input', name: 'newDbName', message: 'Nama database baru:', default: name },
        { type: 'input', name: 'newDbUser', message: 'User database baru:', default: name },
      ]);
      const { passwordMode } = await inquirer.prompt([
        {
          type: 'list',
          name: 'passwordMode',
          message: 'Password user database ini (bukan password root MySQL):',
          choices: [
            { name: 'Generate otomatis (acak, aman, direkomendasikan)', value: 'auto' },
            { name: 'Ketik sendiri', value: 'manual' },
          ],
        },
      ]);
      let customPassword = '';
      if (passwordMode === 'manual') {
        const { pw } = await inquirer.prompt([
          { type: 'password', name: 'pw', message: 'Ketik password untuk user database ini:', mask: '*' },
        ]);
        customPassword = pw;
      }

      logger.info('Membuat database...');
      const dbResult = database.createDatabase(newDbName, newDbUser, customPassword);
      if (!dbResult.ok) {
        logger.error(`Gagal membuat database: ${dbResult.errorMessage}`);
        logger.error('Deploy dibatalkan supaya nggak lanjut dengan DATABASE_URL kosong/rusak.');
        await afterAction(deployNewMenu);
        return;
      } else {
        dbRegistry.upsertEntry({
          dbName: dbResult.dbName,
          dbUser: dbResult.dbUser,
          password: dbResult.password,
          connectionUrl: dbResult.connectionUrl,
          usedByProject: name, // tandai langsung saat DB baru dibuat untuk project ini
        });
        autoDatabaseUrl = dbResult.connectionUrl;
        logger.success(`Database "${dbResult.dbName}" dibuat & tercatat (password: ${dbResult.password}).`);
      }
    }
  }


  logger.card(
    'Konfirmasi Deploy',
    [
      `Nama: ${name}`,
      `Repo: ${gitRepo} (${branch})`,
      `Domain: ${domain}`,
      `Port: ${port}`,
      `Folder: ${folderPath}`,
      `Deploy user: ${deployUser}`,
      `Prisma: ${prismaMode === 'none' ? 'Tidak dipakai' : prismaMode}`,
      `Database URL: ${autoDatabaseUrl ? '(sudah disiapkan otomatis)' : '(belum ada, isi manual nanti di .env)'}`,
    ],
    { color: 'yellow' }
  );

  const { confirm } = await inquirer.prompt([
    { type: 'confirm', name: 'confirm', message: 'Lanjut clone & deploy dengan konfigurasi ini?', default: false },
  ]);

  if (!confirm) {
    logger.info('Deploy dibatalkan.');
    await afterAction(deployNewMenu);
    return;
  }

  logger.info('Memulai proses deploy, ini bisa memakan waktu beberapa menit...\n');

  const deployOpts = { name, gitRepo, cloneUrl, branch, domain, port, folderPath, deployUser, prismaMode };
  const stepReporter = (stepName, ok, message) => {
    ok ? logger.success(`${stepName}: ${message}`) : logger.error(`${stepName}: ${message}`);
  };

  const cloneResult = deployNew.prepareAndClone(deployOpts, stepReporter);
  let result = cloneResult;

  if (cloneResult.ok) {
    // Repo sudah ter-clone - baru sekarang bisa cek .env.example di dalamnya,
    // supaya .env yang dibuat berbasis template asli project (bukan template
    // statis nebak-nebak), dengan DATABASE_URL yang sudah otomatis terisi.
    const envExamplePath = path.join(folderPath, '.env.example');
    let templateContent = null;
    try {
      if (fs.existsSync(envExamplePath)) templateContent = fs.readFileSync(envExamplePath, 'utf-8');
    } catch (err) {
      templateContent = null;
    }

    let defaultEnvContent;
    if (templateContent !== null) {
      logger.info('Ditemukan .env.example di repo - dipakai sebagai template.');
      defaultEnvContent = /^DATABASE_URL=.*/m.test(templateContent)
        ? templateContent.replace(/^DATABASE_URL=.*/m, `DATABASE_URL="${autoDatabaseUrl}"`)
        : `${templateContent}\nDATABASE_URL="${autoDatabaseUrl}"\n`;
      if (!/^PORT=.*/m.test(defaultEnvContent)) {
        defaultEnvContent += `PORT=${port}\n`;
      }
    } else {
      defaultEnvContent = `DATABASE_URL="${autoDatabaseUrl}"\nPORT=${port}\n`;
    }

    const { needsEnv } = await inquirer.prompt([
      { type: 'confirm', name: 'needsEnv', message: 'Project ini butuh file .env?', default: true },
    ]);

    let envContent = '';
    if (needsEnv) {
      const { content } = await inquirer.prompt([
        {
          type: 'editor',
          name: 'content',
          message: 'Isi file .env (editor bakal kebuka, isi lalu simpan+keluar):',
          default: defaultEnvContent,
        },
      ]);
      envContent = content;
    }

    result = deployNew.finishDeploy({ ...deployOpts, envContent }, stepReporter);

    if (!result.ok) {
      const recovery = await handleDeployFailure(deployOpts, result, stepReporter);
      result = recovery.ok ? { ok: true } : result;
    }
  }

  if (result.ok) {
    logger.card('Deploy Selesai', [`Project "${name}" berhasil di-deploy dan aktif (HTTP).`], { color: 'green' });

    const { enableHttps } = await inquirer.prompt([
      { type: 'confirm', name: 'enableHttps', message: 'Enable HTTPS sekarang lewat certbot?', default: true },
    ]);

    if (enableHttps) {
      const acmeCheck = nginx.ensureAcmeChallenge(`${domain}.conf`);
      if (!acmeCheck.ok) {
        logger.error(`Gagal siapkan ACME route: ${acmeCheck.errorMessage}`);
        logger.warn('Site tetap jalan di HTTP. Coba lagi manual lewat menu 7. SSL Manager.');
        await afterAction(deployNewMenu);
        return;
      }

      logger.info(`Menerbitkan sertifikat untuk "${domain}"...`);
      const issueResult = ssl.issueCertificate(domain);
      if (!issueResult.ok) {
        logger.error(`Gagal terbitkan sertifikat: ${issueResult.errorMessage}`);
        logger.warn('Site tetap jalan di HTTP. Coba lagi manual lewat menu 7. SSL Manager.');
      } else {
        const upgradeResult = nginx.upgradeToSSL({ domain, port, fullchain: issueResult.fullchain, privkey: issueResult.privkey });
        upgradeResult.ok
          ? logger.success(`HTTPS aktif untuk "${domain}".`)
          : logger.error(`Gagal aktifkan HTTPS di nginx: ${upgradeResult.errorMessage}`);
      }
    }
  } else {
    logger.card(
      'Deploy Berhenti',
      [
        `Gagal di step: ${result.stoppedAt}`,
        'Folder project (kalau sudah ter-clone) TIDAK dihapus otomatis.',
        `Menu "Deploy Project Baru" dari awal akan ditolak Safety Check selama folder "${folderPath}" masih ada. ` +
          'Perbaiki manual di dalam folder itu (.env, dll) lalu jalankan sisa step manual, atau hapus foldernya dulu sebelum coba deploy ulang.',
      ],
      { color: 'red' }
    );
  }

  await afterAction(deployNewMenu);
}

/**
 * Recovery flow saat finishDeploy() gagal di tengah jalan (mis. Prisma db
 * push gagal karena DATABASE_URL salah). User bisa:
 *  1. Edit .env      - buka isi .env project, benerin, lalu KEMBALI ke menu
 *                      ini (bukan langsung retry) supaya bisa dicek dulu.
 *  2. Retry          - lanjut dari step yang gagal saja (skip step yang
 *                      sudah sukses, tanpa clone ulang / install ulang).
 *  3. Exit           - berhenti, folder project TETAP ada di disk.
 *
 * @param {object} deployOpts   - opts yang sama dipakai buat finishDeploy
 * @param {object} initialResult - hasil finishDeploy yang gagal (stoppedAtKey dkk)
 * @param {function} stepReporter
 * @returns {{ok: boolean}} - ok:true kalau akhirnya berhasil lewat retry
 */
async function handleDeployFailure(deployOpts, initialResult, stepReporter) {
  let currentResult = initialResult;

  while (true) {
    const lastStep = currentResult.steps[currentResult.steps.length - 1];
    logger.card(
      'Deploy Gagal',
      [
        `Step: ${currentResult.stoppedAt}`,
        `Error: ${lastStep ? lastStep.message : '(tidak ada detail)'}`,
        `Folder project tetap ada di: ${deployOpts.folderPath}`,
      ],
      { color: 'red' }
    );

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Pilih aksi recovery:',
        choices: [
          { name: '1. Edit .env', value: 'editEnv' },
          { name: '2. Retry (lanjut dari step gagal)', value: 'retry' },
          { name: '3. Exit', value: 'exit' },
        ],
      },
    ]);

    if (action === 'exit') {
      logger.info(
        `Deploy dihentikan. Folder project di "${deployOpts.folderPath}" TIDAK dihapus. ` +
          'Catatan: menu "Deploy Project Baru" dari awal TIDAK bisa dipakai buat lanjutin ini nanti - Safety Check ' +
          'bakal nolak karena foldernya sudah ada. Kalau mau lanjut lagi belakangan, edit .env manual di folder itu ' +
          'lalu jalankan npm install/prisma/build/pm2 secara manual, atau hapus folder ini dulu sebelum deploy ulang.'
      );
      return { ok: false };
    }

    if (action === 'editEnv') {
      const { content: currentEnv } = env.readEnv(deployOpts.folderPath, deployOpts.deployUser);

      const { content } = await inquirer.prompt([
        {
          type: 'editor',
          name: 'content',
          message: 'Edit .env project (simpan+keluar dari editor setelah selesai):',
          default: currentEnv || '',
        },
      ]);

      const writeResult = env.writeEnv(deployOpts.folderPath, deployOpts.deployUser, content);
      writeResult.ok
        ? logger.success('.env berhasil diperbarui.')
        : logger.error(`Gagal update .env: ${writeResult.errorMessage}`);

      // Sengaja TIDAK langsung retry - balik ke menu recovery ini lagi
      // supaya user bisa cek dulu isinya bener sebelum retry.
      continue;
    }

    if (action === 'retry') {
      logger.info(`Melanjutkan deploy dari step: ${currentResult.stoppedAt}...\n`);
      const retryResult = deployNew.finishDeploy(
        { ...deployOpts, envContent: '' }, // .env sudah final di disk, jangan ditimpa ulang
        stepReporter,
        currentResult.stoppedAtKey
      );

      if (retryResult.ok) {
        return { ok: true };
      }

      currentResult = retryResult;
      continue;
    }
  }
}


async function sslManagerMenu() {
  const action = await customMenu.showMenu('🔐 SSL Manager', [
    { key: 'status', label: 'Cek Status SSL Semua Domain', hint: 'Lihat domain mana yang sudah punya HTTPS dan berapa hari lagi sertifikatnya kadaluarsa.' },
    { key: 'enable', label: 'Enable HTTPS untuk Site', hint: 'Terbitkan sertifikat gratis (Let\'s Encrypt) untuk 1 domain dan otomatis ubah config nginx-nya jadi HTTPS.' },
    { key: 'renew', label: 'Renew Semua Sertifikat', hint: 'Perpanjang semua sertifikat yang mau/sudah kadaluarsa. Biasanya nggak perlu manual (certbot auto-renew), ini cuma buat jaga-jaga.' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await showMainMenu();
    return;
  }

  if (action === 'renew') {
    const result = ssl.renewAll();
    result.ok ? logger.success('Proses renew selesai.\n' + result.output) : logger.error(result.errorMessage);
    await afterAction(sslManagerMenu);
    return;
  }

  const { ok, sites, error } = nginx.listSites();
  if (!ok || sites.length === 0) {
    logger.warn(error || 'Belum ada site nginx untuk dicek.');
    await afterAction(sslManagerMenu);
    return;
  }

  if (action === 'status') {
    sites.forEach((s) => {
      const domain = s.domain.split(' ')[0]; // ambil domain pertama kalau ada beberapa (www + non-www)
      const exists = ssl.checkCertExists(domain);
      if (!exists) {
        logger.card(s.domain, ['Belum ada sertifikat SSL'], { color: 'red' });
        return;
      }
      const expiry = ssl.checkExpiry(domain);
      if (!expiry.ok) {
        logger.card(s.domain, ['Ada sertifikat, tapi gagal baca masa berlaku'], { color: 'yellow' });
        return;
      }
      logger.card(s.domain, [`Sisa masa berlaku: ${expiry.daysLeft} hari`], {
        color: expiry.daysLeft < 14 ? 'yellow' : 'green',
      });
    });
    await afterAction(sslManagerMenu);
    return;
  }

  if (action === 'enable') {
    const { file } = await inquirer.prompt([
      {
        type: 'list',
        name: 'file',
        message: 'Pilih site yang mau di-enable HTTPS:',
        choices: sites.map((s) => ({ name: `${s.domain} (${s.target})`, value: s.file })),
      },
    ]);
    const site = sites.find((s) => s.file === file);
    const domain = site.domain.split(' ')[0];
    const port = extractPortFromTarget(site.target);

    if (!port) {
      logger.error('Site ini bukan reverse proxy (nggak ada port terdeteksi), SSL Manager cuma dukung reverse proxy untuk saat ini.');
      await afterAction(sslManagerMenu);
      return;
    }

    logger.card('Konfirmasi Enable HTTPS', [`Domain: ${domain}`, `Port: ${port}`, 'Certbot akan diterbitkan & config nginx akan diubah.'], { color: 'yellow' });
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: 'Lanjut aktifkan HTTPS untuk domain ini?', default: false },
    ]);
    if (!confirm) {
      logger.info('Dibatalkan.');
      await afterAction(sslManagerMenu);
      return;
    }

    logger.info('Memastikan route ACME challenge tersedia di config nginx...');
    const acmeCheck = nginx.ensureAcmeChallenge(file);
    if (!acmeCheck.ok) {
      logger.error(`Gagal siapkan ACME route: ${acmeCheck.errorMessage}`);
      await afterAction(sslManagerMenu);
      return;
    }
    if (acmeCheck.changed) {
      logger.success('Route ACME challenge berhasil ditambahkan (config lama sudah di-backup).');
    }

    logger.info(`Menerbitkan sertifikat untuk "${domain}" lewat certbot (webroot)...`);
    const issueResult = ssl.issueCertificate(domain);
    if (!issueResult.ok) {
      logger.error(issueResult.errorMessage);
      await afterAction(sslManagerMenu);
      return;
    }
    logger.success('Sertifikat berhasil diterbitkan.');

    const upgradeResult = nginx.upgradeToSSL({
      domain,
      port,
      fullchain: issueResult.fullchain,
      privkey: issueResult.privkey,
    });
    upgradeResult.ok
      ? logger.success(`HTTPS aktif untuk "${domain}". Config lama sudah di-backup otomatis.`)
      : logger.error(upgradeResult.errorMessage);
  }

  await afterAction(sslManagerMenu);
}

async function databaseManagerMenu() {
  const action = await customMenu.showMenu('🗄️  Database Manager', [
    { key: 'list', label: 'List Database' },
    { key: 'browse', label: '🔍 Browse Database (lihat isi)' },
    { key: 'create', label: 'Buat Database Baru' },
    { key: 'import', label: '📥 Daftarkan Database yang Sudah Ada', hint: 'Untuk database yang dibuat DI LUAR tool ini (misal lewat aaPanel) - supaya kredensialnya dikenal tool ini dan bisa dipilih otomatis pas Deploy Project Baru. Ini TIDAK memindahkan/mengubah data, cuma mencatat kredensial.' },
    { key: 'import-sql', label: '📂 Import SQL ke Database', hint: 'Import file .sql / .sql.gz ke database. Tool otomatis cari file di folder backup, /root, dan home dir. Cocok buat migrasi data dari aaPanel atau backup eksternal.' },
    { key: 'drop', label: 'Hapus Database' },
    { key: 'setup-admin', label: '🔧 Setup User Admin DB (fix auth_socket)', hint: 'PENTING kalau root MySQL pakai auth_socket (nggak bisa login password sama sekali). Bikin user admin baru pakai password, lalu otomatis simpan ke Configuration - biar sinkron, nggak perlu isi manual.' },
    { key: 'test-root', label: 'Tes Koneksi MySQL (root - cek service nyala)', hint: 'Cek apakah service MySQL/MariaDB bisa diakses pakai kredensial root yang ada di Configuration.' },
    { key: 'test-project', label: 'Tes Koneksi Database Project', hint: 'Tes koneksi pakai kredensial spesifik database tertentu (bukan root). Sekalian tampilkan info project yang pakai DB ini.' },
    { key: 'reset-password', label: 'Reset Password User (kalau lupa)' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await showMainMenu();
    return;
  }

  if (action === 'browse') {
    await browseDatabaseMenu();
    return;
  }


  if (action === 'setup-admin') {
    logger.info(
      'Ini bikin user MySQL baru yang auth pakai PASSWORD (bukan auth_socket), lalu otomatis ' +
      'menyimpannya ke Configuration sebagai db_root_user/db_root_password. Perlu akses sudo di server ini.'
    );
    const { dbUser, password, confirmPassword } = await inquirer.prompt([
      { type: 'input', name: 'dbUser', message: 'Nama user admin baru:', default: 'vpsmanager' },
      { type: 'password', name: 'password', message: 'Password (min 8 char, besar+kecil+angka+simbol):', mask: '*' },
      { type: 'password', name: 'confirmPassword', message: 'Ulangi password:', mask: '*' },
    ]);

    if (!dbUser || !NAME_REGEX.test(dbUser)) {
      logger.error('Nama user tidak valid (hanya huruf/angka/underscore/dash).');
      await afterAction(databaseManagerMenu);
      return;
    }
    if (!password) {
      logger.error('Password tidak boleh kosong.');
      await afterAction(databaseManagerMenu);
      return;
    }
    if (password !== confirmPassword) {
      logger.error('Password dan konfirmasi tidak sama.');
      await afterAction(databaseManagerMenu);
      return;
    }

    // `sudo mysql` (root pakai auth_socket) HARUS lewat unix socket - nggak bisa
    // TCP sama sekali. Tapi default socket path bawaan binary mysql client bisa
    // salah (mis. /tmp/mysql.sock) padahal socket asli MySQL-nya di lokasi lain
    // (mis. /var/run/mysqld/mysqld.sock) - sama persis kasus yang bikin
    // "Can't connect through socket" sebelumnya. Deteksi socket yang BENERAN
    // ada sebagai file socket di disk, jangan asumsi default.
    const socketCandidates = [
      '/var/run/mysqld/mysqld.sock',
      '/var/lib/mysql/mysql.sock',
      '/tmp/mysql.sock',
    ];
    const socketCheckCmd = socketCandidates
      .map((p) => `[ -S "${p}" ] && echo "${p}" && exit 0;`)
      .join(' ');
    const socketResult = shell.run(`bash -c '${socketCheckCmd} exit 1'`, { silent: true });
    if (!socketResult.ok || !socketResult.output.trim()) {
      logger.error(
        'Tidak ketemu file socket MySQL yang aktif di lokasi umum ' +
        `(${socketCandidates.join(', ')}). Cek manual: sudo lsof -p <pid mysqld> | grep sock`
      );
      await afterAction(databaseManagerMenu);
      return;
    }
    const mysqlSocket = socketResult.output.trim();

    const escapedPw = password.replace(/'/g, "''");
    const sql = `
      CREATE USER IF NOT EXISTS '${dbUser}'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY '${escapedPw}';
      CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED WITH mysql_native_password BY '${escapedPw}';
      ALTER USER '${dbUser}'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY '${escapedPw}';
      ALTER USER '${dbUser}'@'localhost' IDENTIFIED WITH mysql_native_password BY '${escapedPw}';
      GRANT ALL PRIVILEGES ON *.* TO '${dbUser}'@'127.0.0.1' WITH GRANT OPTION;
      GRANT ALL PRIVILEGES ON *.* TO '${dbUser}'@'localhost' WITH GRANT OPTION;
      FLUSH PRIVILEGES;
    `.replace(/\n\s*/g, ' ');

    // Pakai `sudo mysql` (bukan shell.run biasa dengan -u/-p), karena tujuan
    // fitur ini justru dipakai SAAT root belum bisa login pakai password sama
    // sekali (auth_socket) - satu-satunya jalan masuk sekarang adalah lewat
    // sudo + socket, sesuai OS user yang di-mapping ke root@localhost.
    const createResult = shell.run(`sudo mysql --socket="${mysqlSocket}" -e "${sql.replace(/"/g, '\\"')}"`, { silent: true });
    if (!createResult.ok) {
      logger.error(`Gagal bikin user admin: ${createResult.errorMessage}`);
      await afterAction(databaseManagerMenu);
      return;
    }

    const testResult = database.testCredentials('mysql', dbUser, password);
    if (!testResult.ok) {
      logger.error(
        `User "${dbUser}" berhasil dibuat, tapi tes koneksi via TCP gagal: ${testResult.errorMessage}\n` +
        'Configuration TIDAK diubah - cek manual dulu sebelum coba lagi.'
      );
      await afterAction(databaseManagerMenu);
      return;
    }

    const cfg = config.loadConfig();
    config.saveConfig({ ...cfg, db_root_user: dbUser, db_root_password: password });
    logger.success(
      `✅ User "${dbUser}" berhasil dibuat dan tes koneksi sukses. Configuration otomatis di-update ` +
      `(db_root_user="${dbUser}") - semua fitur Database Manager & Backup Manager sekarang pakai user ini.`
    );
    await afterAction(databaseManagerMenu);
    return;
  }

  if (action === 'test-root') {
    const result = database.testConnection();
    result.ok
      ? logger.success('✅ Koneksi MySQL (root) berhasil. Service MySQL/MariaDB berjalan normal.')
      : logger.error(result.errorMessage);
    await afterAction(databaseManagerMenu);
    return;
  }

  if (action === 'test-project') {
    const entries = dbRegistry.listEntries();
    if (entries.length === 0) {
      logger.warn('Belum ada database yang tercatat di registry. Buat atau daftarkan database dulu lewat menu di atas.');
      await afterAction(databaseManagerMenu);
      return;
    }
    const { picked } = await inquirer.prompt([
      {
        type: 'list',
        name: 'picked',
        message: 'Pilih database yang mau dites:',
        choices: [
          ...entries.map((e) => ({
            name: `${e.dbName}  (user: ${e.dbUser}${e.usedByProject ? ' | project: ' + e.usedByProject : ''})`,
            value: e.dbName,
          })),
          { name: '↩️  Kembali', value: '__back__' },
        ],
      },
    ]);
    if (picked === '__back__') {
      await databaseManagerMenu();
      return;
    }

    const entry = dbRegistry.findByName(picked);
    logger.info(`Menguji koneksi ke database "${entry.dbName}" pakai user "${entry.dbUser}"...`);
    const testResult = database.testCredentials(entry.dbName, entry.dbUser, entry.password);

    const infoLines = [
      `Database : ${entry.dbName}`,
      `User     : ${entry.dbUser}`,
      `URL      : ${entry.connectionUrl}`,
      `Project  : ${entry.usedByProject || '(tidak ada info project terkait)'}`,
    ];

    if (testResult.ok) {
      logger.card('✅ Koneksi Berhasil', infoLines, { color: 'green' });
    } else {
      logger.card('❌ Koneksi Gagal', [...infoLines, '', `Error: ${testResult.errorMessage}`], { color: 'red' });
    }
    await afterAction(databaseManagerMenu);
    return;
  }


  if (action === 'list') {
    const { ok, databases, error } = database.listDatabases();
    if (!ok) {
      logger.error(error);
    } else if (databases.length === 0) {
      logger.warn('Belum ada database custom.');
    } else {
      databases.forEach((db) => logger.card(`🗄️  ${db}`, [], { color: 'cyan' }));
    }
    await afterAction(databaseManagerMenu);
    return;
  }

  if (action === 'create') {
    const { dbName, dbUser } = await inquirer.prompt([
      { type: 'input', name: 'dbName', message: 'Nama database (huruf/angka/underscore):' },
      { type: 'input', name: 'dbUser', message: 'Nama user database:' },
    ]);
    const { passwordMode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'passwordMode',
        message: 'Password user:',
        choices: [
          { name: 'Generate otomatis (acak, aman)', value: 'auto' },
          { name: 'Ketik sendiri', value: 'manual' },
        ],
      },
    ]);
    let customPassword = '';
    if (passwordMode === 'manual') {
      const { pw } = await inquirer.prompt([
        { type: 'password', name: 'pw', message: 'Ketik password:', mask: '*' },
      ]);
      customPassword = pw;
    }

    logger.card(
      'Konfirmasi Buat Database',
      [`Database: ${dbName}`, `User: ${dbUser}`, `Password: ${passwordMode === 'manual' ? '(sesuai input)' : '(di-generate otomatis)'}`],
      { color: 'yellow' }
    );
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: 'Buat database ini sekarang?', default: false },
    ]);
    if (!confirm) {
      logger.info('Dibatalkan.');
      await afterAction(databaseManagerMenu);
      return;
    }

    const result = database.createDatabase(dbName, dbUser, customPassword);
    if (!result.ok) {
      logger.error(result.errorMessage);
    } else {
      dbRegistry.upsertEntry({
        dbName: result.dbName,
        dbUser: result.dbUser,
        password: result.password,
        connectionUrl: result.connectionUrl,
      });
      logger.card(
        'Database Berhasil Dibuat',
        [
          `Database: ${result.dbName}`,
          `User: ${result.dbUser}`,
          `Password: ${result.password}`,
          `Connection URL: ${result.connectionUrl}`,
          '',
          'SIMPAN password ini sekarang, tidak akan ditampilkan lagi!',
          'Kalau lupa nanti, pakai menu "Reset Password User".',
          '(Sudah otomatis tercatat, bisa dipilih dari list pas Deploy Project Baru.)',
        ],
        { color: 'green' }
      );
    }
    await afterAction(databaseManagerMenu);
    return;
  }

  if (action === 'import') {
    const { ok, databases, error } = database.listDatabases();
    if (!ok || databases.length === 0) {
      logger.warn(error || 'Belum ada database di server ini.');
      await afterAction(databaseManagerMenu);
      return;
    }
    const known = dbRegistry.listEntries().map((e) => e.dbName);
    const importable = databases.filter((d) => !known.includes(d));
    if (importable.length === 0) {
      logger.warn('Semua database yang ada sudah tercatat.');
      await afterAction(databaseManagerMenu);
      return;
    }

    const { dbName } = await inquirer.prompt([
      {
        type: 'list',
        name: 'dbName',
        message: 'Pilih database yang mau didaftarkan:',
        choices: [...importable, { name: '↩️  Kembali', value: '__back__' }],
      },
    ]);
    if (dbName === '__back__') {
      await databaseManagerMenu();
      return;
    }

    const { dbUser, password } = await inquirer.prompt([
      { type: 'input', name: 'dbUser', message: 'User MySQL yang sudah dipakai database ini:' },
      { type: 'password', name: 'password', message: 'Password user tersebut:', mask: '*' },
    ]);

    logger.info('Menguji koneksi pakai kredensial ini...');
    const testResult = database.testCredentials(dbName, dbUser, password);
    if (!testResult.ok) {
      logger.error(`Koneksi gagal, kredensial belum disimpan: ${testResult.errorMessage}`);
      await afterAction(databaseManagerMenu);
      return;
    }
    logger.success('Koneksi berhasil.');

    const connectionUrl = `mysql://${dbUser}:${password}@127.0.0.1:3306/${dbName}`;
    logger.card('Konfirmasi Simpan', [`Database: ${dbName}`, `User: ${dbUser}`, `Connection URL: ${connectionUrl}`], {
      color: 'yellow',
    });
    const { confirmImport } = await inquirer.prompt([
      { type: 'confirm', name: 'confirmImport', message: 'Simpan kredensial ini ke registry?', default: true },
    ]);
    if (confirmImport) {
      dbRegistry.upsertEntry({ dbName, dbUser, password, connectionUrl });
      logger.success(`Database "${dbName}" berhasil didaftarkan. Sekarang bisa dipilih dari list pas Deploy Project Baru.`);
    } else {
      logger.info('Dibatalkan.');
    }
    await afterAction(databaseManagerMenu);
    return;
  }

  if (action === 'import-sql') {
    // 1. Pilih database tujuan
    const { ok: dbOk, databases: allDbs, error: dbErr } = database.listDatabases();
    if (!dbOk || allDbs.length === 0) {
      logger.warn(dbErr || 'Belum ada database di server ini. Buat database dulu lewat menu "Buat Database Baru".');
      await afterAction(databaseManagerMenu);
      return;
    }
    const { targetDb } = await inquirer.prompt([
      {
        type: 'list',
        name: 'targetDb',
        message: 'Import SQL ke database mana?',
        choices: [...allDbs, { name: '↩️  Kembali', value: '__back__' }],
      },
    ]);
    if (targetDb === '__back__') {
      await databaseManagerMenu();
      return;
    }

    // 2. Scan file .sql/.sql.gz di folder umum
    logger.info('Mencari file .sql / .sql.gz di folder backup, /root, dan home dir...');
    const { found, scannedDirs } = backup.scanSqlFiles();

    let chosenPath = null;

    if (found.length > 0) {
      // Buat choices dari file yang ketemu, plus fallback input manual
      const fileChoices = found.map((f) => ({
        name: `${f.file}  [${f.dir}]`,
        value: f.fullPath,
      }));
      fileChoices.push({ name: '📁 Ketik path manual (file tidak ada di atas)', value: '__manual__' });
      fileChoices.push({ name: '↩️  Kembali', value: '__back__' });

      logger.info(`Ditemukan ${found.length} file di: ${scannedDirs.join(', ')}`);

      const { sqlFile } = await inquirer.prompt([
        {
          type: 'list',
          name: 'sqlFile',
          message: 'Pilih file SQL yang mau diimport:',
          choices: fileChoices,
        },
      ]);

      if (sqlFile === '__back__') {
        await databaseManagerMenu();
        return;
      }
      if (sqlFile === '__manual__') {
        const { manualPath } = await inquirer.prompt([
          { type: 'input', name: 'manualPath', message: 'Path lengkap file .sql / .sql.gz:' },
        ]);
        chosenPath = manualPath.trim();
      } else {
        chosenPath = sqlFile;
      }
    } else {
      // Tidak ketemu file sama sekali, fallback langsung ke input manual
      logger.warn(`Tidak ada file .sql / .sql.gz ditemukan di: ${scannedDirs.join(', ')}`);
      const { manualPath } = await inquirer.prompt([
        { type: 'input', name: 'manualPath', message: 'Ketik path lengkap file .sql / .sql.gz (atau kosongkan untuk batal):' },
      ]);
      if (!manualPath || !manualPath.trim()) {
        logger.info('Dibatalkan.');
        await afterAction(databaseManagerMenu);
        return;
      }
      chosenPath = manualPath.trim();
    }

    if (!chosenPath) {
      logger.info('Dibatalkan.');
      await afterAction(databaseManagerMenu);
      return;
    }

    // 3. Konfirmasi
    const isGz = /\.sql\.gz$/i.test(chosenPath);
    logger.card(
      'Konfirmasi Import SQL',
      [
        `File   : ${chosenPath}`,
        `Format : ${isGz ? '.sql.gz (akan di-gunzip otomatis)' : '.sql'}`,
        `Target : database "${targetDb}"`,
        '',
        '⚠️  Ini akan MENAMBAH/MENIMPA data di database tersebut.',
        'Pastikan sudah backup database dulu kalau perlu.',
      ],
      { color: 'yellow' }
    );
    const { confirmImportSql } = await inquirer.prompt([
      { type: 'confirm', name: 'confirmImportSql', message: 'Lanjut import sekarang?', default: false },
    ]);
    if (!confirmImportSql) {
      logger.info('Dibatalkan.');
      await afterAction(databaseManagerMenu);
      return;
    }

    // 4. Jalankan import
    logger.info('⏳ Mengimport SQL, mohon tunggu...');
    const importResult = backup.importSqlFile(chosenPath, targetDb);
    if (importResult.ok) {
      logger.success(`Import SQL ke database "${targetDb}" berhasil.`);
    } else {
      logger.error(`Import gagal: ${importResult.errorMessage}`);
    }
    await afterAction(databaseManagerMenu);
    return;
  }

  if (action === 'reset-password') {
    // Pilih database dari list
    const { ok: dbListOk, databases: allDbsForReset, error: dbListErr } = database.listDatabases();
    if (!dbListOk || allDbsForReset.length === 0) {
      logger.warn(dbListErr || 'Belum ada database di server ini.');
      await afterAction(databaseManagerMenu);
      return;
    }
    const { dbName } = await inquirer.prompt([
      {
        type: 'list',
        name: 'dbName',
        message: 'Pilih database yang mau di-reset password-nya:',
        choices: [...allDbsForReset, { name: '↩️  Kembali', value: '__back__' }],
      },
    ]);
    if (dbName === '__back__') {
      await databaseManagerMenu();
      return;
    }

    // Auto-isi dbUser dari registry kalau ada
    const registryEntry = dbRegistry.findByName(dbName);
    const defaultUser = registryEntry ? registryEntry.dbUser : '';
    const userHint = registryEntry
      ? `(tercatat di registry: "${registryEntry.dbUser}", tekan Enter untuk pakai ini)`
      : '(database ini tidak dikenal registry, ketik manual)';

    const { dbUser } = await inquirer.prompt([
      {
        type: 'input',
        name: 'dbUser',
        message: `Nama user yang mau di-reset password-nya ${userHint}:`,
        default: defaultUser,
      },
    ]);

    const { passwordMode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'passwordMode',
        message: 'Password baru:',
        choices: [
          { name: 'Generate otomatis (acak, aman)', value: 'auto' },
          { name: 'Ketik sendiri', value: 'manual' },
        ],
      },
    ]);
    let customPassword = '';
    if (passwordMode === 'manual') {
      const { pw } = await inquirer.prompt([
        { type: 'password', name: 'pw', message: 'Ketik password baru:', mask: '*' },
      ]);
      customPassword = pw;
    }

    logger.card('Konfirmasi Reset Password', [`Database: ${dbName}`, `User: ${dbUser}`], { color: 'yellow' });
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: 'Reset password user ini sekarang?', default: false },
    ]);
    if (!confirm) {
      logger.info('Dibatalkan.');
      await afterAction(databaseManagerMenu);
      return;
    }

    const result = database.resetPassword(dbName, dbUser, customPassword);
    if (!result.ok) {
      logger.error(result.errorMessage);
    } else {
      // Bug B fix: sync password baru ke registry supaya connectionUrl tidak basi.
      // Bug C fix: merge entry LAMA dulu (registryEntry, sudah diambil di atas
      // buat auto-isi dbUser) - sebelumnya di sini langsung upsert object baru
      // {dbName, dbUser, password, connectionUrl} tanpa spread entry lama,
      // jadi field lain kayak usedByProject ikut KEHAPUS diam-diam tiap kali
      // reset password. Sekarang field lama dipertahankan, cuma 4 field ini
      // yang ditimpa dengan nilai baru dari hasil resetPassword().
      dbRegistry.upsertEntry({
        ...registryEntry,
        dbName: result.dbName,
        dbUser: result.dbUser,
        password: result.password,
        connectionUrl: result.connectionUrl,
      });
      logger.card(
        'Password Berhasil Direset',
        [
          `Database: ${result.dbName}`,
          `User: ${result.dbUser}`,
          `Password baru: ${result.password}`,
          `Connection URL: ${result.connectionUrl}`,
          '',
          'Registry sudah diupdate otomatis.',
          'Jangan lupa update .env project yang pakai user ini!',
        ],
        { color: 'green' }
      );
    }
    await afterAction(databaseManagerMenu);
    return;
  }

  if (action === 'drop') {
    const { ok, databases } = database.listDatabases();
    if (!ok || databases.length === 0) {
      logger.warn('Belum ada database untuk dihapus.');
      await afterAction(databaseManagerMenu);
      return;
    }
    const { dbName } = await inquirer.prompt([
      {
        type: 'list',
        name: 'dbName',
        message: 'Pilih database yang mau dihapus:',
        choices: [...databases, { name: '↩️  Kembali', value: '__back__' }],
      },
    ]);
    if (dbName === '__back__') {
      await databaseManagerMenu();
      return;
    }

    // Tampilkan info registry kalau ada (supaya operator tahu user mana yang terkait)
    const dropEntry = dbRegistry.findByName(dbName);
    const defaultDropUser = dropEntry ? dropEntry.dbUser : '';
    const dropHint = dropEntry
      ? `(tercatat di registry: user "${dropEntry.dbUser}"${dropEntry.usedByProject ? ', project: ' + dropEntry.usedByProject : ''})`
      : '(tidak ada di registry, kosongkan kalau nggak perlu hapus user)';

    const { dbUser } = await inquirer.prompt([
      {
        type: 'input',
        name: 'dbUser',
        message: `Nama user yang mau ikut dihapus ${dropHint}:`,
        default: defaultDropUser,
      },
    ]);
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `YAKIN hapus database "${dbName}"? Semua data di dalamnya akan HILANG PERMANEN.`,
        default: false,
      },
    ]);
    if (!confirm) {
      logger.info('Dibatalkan.');
    } else {
      const result = database.dropDatabase(dbName, dbUser);
      if (result.ok) {
        // Bug A fix: hapus entry dari registry supaya tidak muncul lagi di list existing
        dbRegistry.removeEntry(dbName);
        logger.success(`Database "${dbName}" berhasil dihapus dan dihapus dari registry.`);
      } else {
        logger.error(result.errorMessage);
      }
    }
  }

  await afterAction(databaseManagerMenu);
}

/**
 * Browse Database: cuma buat CEK ISI (read-only) - Show Tables, Describe,
 * Lihat Isi, Jumlah Baris. Nggak ada aksi tulis/hapus di sini sama sekali.
 * Navigasi "Kembali" tiap level balik ke level di atasnya langsung (bukan
 * selalu ke Main Menu), soalnya alurnya 4 level dalam (Database Manager →
 * pilih db → pilih tabel → aksi) - kalau tiap kembali lompat ke Main Menu,
 * ganti-ganti kolom/tabel jadi harus pilih ulang dari nol tiap kali.
 */
/**
 * Format array kolom jadi tabel monospace rata (fixed-width per kolom),
 * dipakai buat Describe biar align rapi - bukan dump tab-separated mentah
 * dari mysql CLI yang berantakan kalau dibungkus box.
 */

async function browseDatabaseMenu() {
  const { ok, databases, error } = database.listDatabases();
  if (!ok) {
    logger.error(error || 'Gagal ambil daftar database.');
    await afterAction(databaseManagerMenu);
    return;
  }
  if (databases.length === 0) {
    logger.warn('Belum ada database untuk di-browse.');
    await afterAction(databaseManagerMenu);
    return;
  }

  const dbName = await customMenu.showMenu('🔍 Browse Database - Pilih Database', [
    ...databases.map((db) => ({ key: db, label: `🗄️  ${db}` })),
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (dbName === 'back') {
    await databaseManagerMenu();
    return;
  }

  await browseTableMenu(dbName);
}

async function browseTableMenu(dbName) {
  const { ok, tables, errorMessage } = database.listTables(dbName);
  if (!ok) {
    logger.error(errorMessage || 'Gagal ambil daftar tabel.');
    await afterAction(browseDatabaseMenu);
    return;
  }
  if (tables.length === 0) {
    logger.warn(`Database "${dbName}" belum punya tabel.`);
    await afterAction(browseDatabaseMenu);
    return;
  }

  const tableName = await customMenu.showMenu(`🔍 ${dbName} - Pilih Tabel`, [
    ...tables.map((t) => ({ key: t, label: `📋 ${t}` })),
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (tableName === 'back') {
    await browseDatabaseMenu();
    return;
  }

  await tableActionMenu(dbName, tableName);
}

async function tableActionMenu(dbName, tableName) {
  const action = await customMenu.showMenu(`📋 ${dbName}.${tableName}`, [
    { key: 'describe', label: 'Describe (struktur kolom)' },
    { key: 'preview', label: 'Lihat Isi (10 baris)' },
    { key: 'count', label: 'Jumlah Baris' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await browseTableMenu(dbName);
    return;
  }

  if (action === 'describe') {
    const result = database.describeTable(dbName, tableName);
    if (!result.ok) {
      logger.error(result.errorMessage);
    } else {
      const rows = result.columns.map((c) => [c.field, c.type, c.nullable, c.key]);
      const lines = formatAlignedTable(['Field', 'Type', 'Null', 'Key'], rows);
      logger.card(`📐 Struktur: ${tableName}`, lines, { color: 'blue' });
    }
  } else if (action === 'count') {
    const result = database.countRows(dbName, tableName);
    result.ok
      ? logger.card(`🔢 Jumlah Baris: ${tableName}`, [`Total: ${result.total} baris`], { color: 'cyan' })
      : logger.error(result.errorMessage);
  } else if (action === 'preview') {
    const result = database.previewTable(dbName, tableName);
    if (!result.ok) {
      logger.error(result.errorMessage);
    } else if (result.rows.length === 0) {
      logger.warn(`Tabel "${tableName}" kosong, belum ada data.`);
    } else {
      result.rows.forEach((fields, idx) => {
        logger.card(`Row ${idx + 1}`, fields.map((f) => `${f.key}: ${f.value}`), { color: 'green' });
      });
    }
  }

  await tableActionAfter(dbName, tableName);
}

async function tableActionAfter(dbName, tableName) {
  const next = await customMenu.showMenu('Lanjut ke mana?', [
    { key: 'repeat', label: `🔁 ${tableName} lagi` },
    { key: 'tables', label: `📋 Pilih Tabel Lain (${dbName})` },
    { key: 'databases', label: '🗄️  Pilih Database Lain' },
    { key: 'main', label: '🏠 Menu Utama' },
    { key: 'exit', label: '🚪 Keluar' },
  ]);

  if (next === 'repeat') await tableActionMenu(dbName, tableName);
  else if (next === 'tables') await browseTableMenu(dbName);
  else if (next === 'databases') await browseDatabaseMenu();
  else if (next === 'main') await showMainMenu();
  else {
    logger.info('Sampai jumpa!');
    process.exit(0);
  }
}

async function deployOldMenu() {
  logger.section('Import Project ke Registry (Bukan Deploy)');
  logger.info('Fitur ini CUMA mendaftarkan project ke registry, SAMA SEKALI TIDAK melakukan deploy apapun.');
  logger.info('Nginx & proses yang lagi jalan TIDAK disentuh - hanya bikin project ini "kelihatan" di Git/PM2/Project/Backup Manager.\n');

  const cfg = config.loadConfig();

  // Auto-scan app PM2 yang jalan + site nginx yang ada, buang yang SUDAH
  // terdaftar di registry, biar user tinggal pilih daripada ngetik semua
  // field manual (nama, path, port, domain) satu-satu.
  const registeredPaths = new Set(registry.listProjects().map((p) => p.path));
  const pm2Result = pm2.listApps();
  const nginxResult = nginx.listSites();
  const sites = nginxResult.ok ? nginxResult.sites : [];

  const candidates = (pm2Result.apps || [])
    .filter((app) => app.cwd && app.cwd !== '-' && !registeredPaths.has(app.cwd))
    .map((app) => {
      const matchedSite = sites.find((s) => s.target && app.port !== '-' && s.target.includes(`:${app.port}`));
      return {
        name: app.name,
        path: app.cwd,
        port: app.port !== '-' ? app.port : 0,
        deployUser: app.owner,
        domain: matchedSite ? matchedSite.domain : '',
      };
    });

  let picked = null;
  if (candidates.length > 0) {
    const { candidateChoice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'candidateChoice',
        message: 'Terdeteksi app PM2 yang belum terdaftar. Pilih salah satu, atau isi manual:',
        choices: [
          ...candidates.map((c) => ({
            name: `${c.name}  (${c.path})${c.port ? '  port:' + c.port : ''}${c.domain ? '  domain:' + c.domain : ''}`,
            value: c.name,
          })),
          { name: '✏️  Isi manual (bukan dari daftar ini)', value: null },
        ],
      },
    ]);
    picked = candidates.find((c) => c.name === candidateChoice) || null;
  }

  let name, folderPath;
  if (picked) {
    ({ name } = picked);
    folderPath = picked.path;
    logger.info(`Dipilih dari daftar terdeteksi: "${name}" di "${folderPath}".`);
  } else {
    ({ name, folderPath } = await inquirer.prompt([
      { type: 'input', name: 'name', message: 'Nama project (unik):', validate: validateName },
      { type: 'input', name: 'folderPath', message: 'Path folder project (yang sudah ada):' },
    ]));
  }

  if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    logger.error(`Folder "${folderPath}" tidak ditemukan. Batal.`);
    await afterAction(deployOldMenu);
    return;
  }

  const { type, domain, port, deployUser } = await inquirer.prompt([
    {
      type: 'list',
      name: 'type',
      message: 'Tipe project:',
      choices: ['nextjs', 'laravel', 'static', 'other'],
    },
    { type: 'input', name: 'domain', message: 'Domain (kalau ada):', default: picked ? picked.domain : '', validate: validateDomainOptional },
    { type: 'number', name: 'port', message: 'Port (kalau ada, kosongkan 0 kalau nggak pakai port):', default: picked ? picked.port : 0 },
    { type: 'input', name: 'deployUser', message: 'Deploy user (owner file di server):', default: picked ? picked.deployUser : cfg.deploy_user },
  ]);

  logger.card(
    'Konfirmasi Import',
    [
      `Nama: ${name}`,
      `Path: ${folderPath}`,
      `Tipe: ${type}`,
      `Domain: ${domain || '-'}`,
      `Port: ${port || '-'}`,
      `Deploy user: ${deployUser}`,
    ],
    { color: 'yellow' }
  );

  const { confirm } = await inquirer.prompt([
    { type: 'confirm', name: 'confirm', message: 'Daftarkan project ini ke registry?', default: true },
  ]);

  if (!confirm) {
    logger.info('Dibatalkan.');
    await afterAction(deployOldMenu);
    return;
  }

  try {
    registry.addProject({
      name,
      type,
      domain: domain || null,
      port: port || null,
      path: folderPath,
      deploy_user: deployUser,
      imported: true,
    });
    logger.success(`Project "${name}" berhasil didaftarkan. Cek di menu 4. Project Manager.`);
    if (!picked && (type === 'nextjs' || type === 'other')) {
      logger.info(
        `Ingat: tool ini TIDAK otomatis nge-start app di PM2. Kalau "${name}" belum jalan di PM2, ` +
        `start manual dulu di server (mis. "cd /path/project && pm2 start npm --name ${name} --cwd /path/project -- run start"), baru setelah itu ` +
        `app-nya bisa dikontrol (Start/Stop/Restart/Logs) lewat menu 5. PM2 Manager.`
      );
    }
  } catch (err) {
    logger.error(err.message);
  }

  await afterAction(deployOldMenu);
}


async function serverMonitorMenu() {
  logger.section('📊 Server Monitor');
  logger.info('Mengambil data server...\n');

  const status = monitor.getStatus();

  // CPU
  logger.card(
    `🖥️  CPU  ${levelEmoji(status.cpuPercent)}`,
    [status.cpuPercent !== null ? `Pemakaian: ${status.cpuPercent}%` : 'Gagal membaca data CPU'],
    { color: levelColor(status.cpuPercent) }
  );

  // RAM
  if (status.ram) {
    logger.card(
      `🧠 RAM  ${levelEmoji(status.ram.percent)}`,
      [
        `Pemakaian: ${status.ram.percent}%`,
        `Terpakai: ${status.ram.usedMB} MB / ${status.ram.totalMB} MB`,
        `Tersedia: ${status.ram.availableMB} MB`,
      ],
      { color: levelColor(status.ram.percent) }
    );
  } else {
    logger.card('🧠 RAM  ❔', ['Gagal membaca data RAM'], { color: 'blue' });
  }

  // Disk
  if (status.disk) {
    logger.card(
      `💾 Disk  ${levelEmoji(status.disk.percent)}`,
      [
        `Pemakaian: ${status.disk.percent}%`,
        `Terpakai: ${status.disk.used} / ${status.disk.total}`,
        `Tersisa: ${status.disk.available}`,
      ],
      { color: levelColor(status.disk.percent) }
    );
  } else {
    logger.card('💾 Disk  ❔', ['Gagal membaca data disk'], { color: 'blue' });
  }

  // Uptime + Load Average
  const loadLines = [];
  if (status.uptime) loadLines.push(`⏱️  Uptime server: ${status.uptime}`);
  if (status.loadAverage) {
    loadLines.push(
      `📈 Load Average: ${status.loadAverage['1min']} (1m) / ${status.loadAverage['5min']} (5m) / ${status.loadAverage['15min']} (15m)`
    );
  }
  if (loadLines.length > 0) {
    logger.card('⏱️  Uptime & Load', loadLines, { color: 'cyan' });
  }

  // Ringkasan keterangan warna
  logger.info('✅ Aman (<60%)   ⚠️ Waspada (60-85%)   🔥 Kritis (>85%)');

  await afterAction(serverMonitorMenu);
}

async function backupManagerMenu() {
  const action = await customMenu.showMenu('💾 Backup Manager', [
    { key: 'backup-project', label: 'Backup Project (folder)', hint: 'Bikin arsip .zip/.tar dari folder project - buat jaga-jaga sebelum ubah-ubah yang berisiko.' },
    { key: 'backup-db', label: 'Backup Database', hint: 'Export isi database ke file backup.' },
    { key: 'list', label: 'List Backup', hint: 'Lihat semua file backup yang tersimpan.' },
    { key: 'restore-project', label: 'Restore Project', hint: 'Kembalikan folder project dari file backup - MENIMPA file yang ada di tujuan. Setelah restore, biasanya app perlu di-Restart juga di PM2 Manager.' },
    { key: 'restore-db', label: 'Restore Database', hint: 'Timpa isi database sekarang dengan isi dari file backup. Tidak bisa dibatalkan setelah jalan.' },
    { key: 'clean', label: 'Hapus Backup Lama (retensi otomatis)', hint: 'Hapus otomatis file backup yang sudah melewati batas umur/jumlah simpan, biar disk nggak penuh.' },
    { key: 'delete', label: 'Hapus Backup Manual', hint: 'Hapus 1 file backup tertentu pilihan kamu sendiri.' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await showMainMenu();
    return;
  }

  if (action === 'backup-project') {
    const projects = registry.listProjects();
    if (projects.length === 0) {
      logger.warn('Belum ada project terdaftar.');
      await afterAction(backupManagerMenu);
      return;
    }
    const { project } = await inquirer.prompt([
      { type: 'list', name: 'project', message: 'Pilih project:', choices: projects.map((p) => ({ name: p.name, value: p })) },
    ]);
    logger.info(`Backup "${project.name}" (nggak termasuk node_modules/.next/.git)...`);
    const result = backup.backupProject(project.name, project.path);
    result.ok ? logger.success(`Backup berhasil: ${result.file}`) : logger.error(result.errorMessage);
  } else if (action === 'backup-db') {
    const { ok, databases } = database.listDatabases();
    if (!ok || databases.length === 0) {
      logger.warn('Belum ada database.');
      await afterAction(backupManagerMenu);
      return;
    }
    const { dbName } = await inquirer.prompt([
      { type: 'list', name: 'dbName', message: 'Pilih database:', choices: databases },
    ]);
    logger.info(`Backup database "${dbName}"...`);
    const result = backup.backupDatabase(dbName);
    result.ok ? logger.success(`Backup berhasil: ${result.file}`) : logger.error(result.errorMessage);
  } else if (action === 'list') {
    const { backups } = backup.listBackups();
    if (backups.length === 0) {
      logger.warn('Belum ada backup.');
    } else {
      backups.forEach((f) => logger.card(`${f.startsWith('db-') ? '🗄️ ' : '📦'} ${f}`, [], { color: f.startsWith('db-') ? 'blue' : 'green' }));
    }
  } else if (action === 'restore-project') {
    const { backups } = backup.listBackups();
    const projectBackups = backups.filter((f) => f.startsWith('project-'));
    if (projectBackups.length === 0) {
      logger.warn('Belum ada backup project.');
      await afterAction(backupManagerMenu);
      return;
    }
    const cfgForRestore = config.loadConfig();
    const { file, targetParentDir, deployUser } = await inquirer.prompt([
      { type: 'list', name: 'file', message: 'Pilih backup:', choices: projectBackups },
      { type: 'input', name: 'targetParentDir', message: 'Restore ke folder induk mana (contoh: /www/wwwroot):' },
      { type: 'input', name: 'deployUser', message: 'Deploy user (owner file hasil restore):', default: cfgForRestore.deploy_user },
    ]);
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: 'Ini bisa menimpa file yang sudah ada di tujuan. Lanjut?', default: false },
    ]);
    if (confirm) {
      logger.info('⏳ Restoring file, mohon tunggu...');
      const result = backup.restoreProject(file, targetParentDir, deployUser);
      if (result.ok) {
        logger.success('Restore berhasil.');
        logger.info('Catatan: restore cuma ganti file di disk, app PM2 yang lagi jalan TIDAK otomatis kebaca file barunya.');
        const { pickApp } = await inquirer.prompt([
          { type: 'confirm', name: 'pickApp', message: 'Restart salah satu app PM2 sekarang biar file hasil restore kepakai?', default: true },
        ]);
        if (pickApp) {
          const { ok, apps } = pm2.listApps();
          if (!ok || apps.length === 0) {
            logger.warn('Belum ada app PM2 untuk dipilih.');
          } else {
            const { selected } = await inquirer.prompt([
              {
                type: 'list',
                name: 'selected',
                message: 'Pilih app yang mau di-restart:',
                choices: apps.map((a) => ({ name: `${a.name} (${a.owner})`, value: `${a.name}|${a.owner}` })),
              },
            ]);
            const [restartName, restartOwner] = selected.split('|');
            const restartResult = pm2.restart(restartName, restartOwner);
            restartResult.ok
              ? logger.success(`"${restartName}" berhasil di-restart.`)
              : logger.error(restartResult.errorMessage);
          }
        }
      } else {
        logger.error(result.errorMessage);
      }
    } else {
      logger.info('Dibatalkan.');
    }
  } else if (action === 'restore-db') {
    const { backups } = backup.listBackups();
    const dbBackups = backups.filter((f) => f.startsWith('db-'));
    if (dbBackups.length === 0) {
      logger.warn('Belum ada backup database.');
      await afterAction(backupManagerMenu);
      return;
    }

    // Pilih file backup dulu
    const { file } = await inquirer.prompt([
      {
        type: 'list',
        name: 'file',
        message: 'Pilih file backup database:',
        choices: [...dbBackups, { name: '↩️  Kembali', value: '__back__' }],
      },
    ]);
    if (file === '__back__') {
      await backupManagerMenu();
      return;
    }

    // Pilih database tujuan dari list (bukan ketik manual)
    const { ok: dbOk, databases: allDbs, error: dbErr } = database.listDatabases();
    if (!dbOk || allDbs.length === 0) {
      logger.warn(dbErr || 'Belum ada database di server ini. Buat database dulu sebelum restore.');
      await afterAction(backupManagerMenu);
      return;
    }
    const { dbName } = await inquirer.prompt([
      {
        type: 'list',
        name: 'dbName',
        message: 'Restore ke database mana?',
        choices: [...allDbs, { name: '↩️  Kembali', value: '__back__' }],
      },
    ]);
    if (dbName === '__back__') {
      await backupManagerMenu();
      return;
    }

    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: `Ini akan MENIMPA isi database "${dbName}" sekarang. Yakin?`, default: false },
    ]);
    if (confirm) {
      logger.info('⏳ Restoring database, mohon tunggu...');
      const result = backup.restoreDatabase(file, dbName);
      result.ok ? logger.success('Restore database berhasil.') : logger.error(result.errorMessage);
    } else {
      logger.info('Dibatalkan.');
    }

  } else if (action === 'clean') {
    const result = backup.cleanOldBackups();
    if (!result.ok) {
      logger.error(result.errorMessage);
    } else if (result.deleted.length === 0) {
      logger.info('Tidak ada backup yang perlu dihapus.');
    } else {
      logger.success(`${result.deleted.length} file backup lama dihapus.`);
    }
  } else if (action === 'delete') {
    const { backups } = backup.listBackups();
    if (backups.length === 0) {
      logger.warn('Belum ada backup.');
      await afterAction(backupManagerMenu);
      return;
    }
    const { file } = await inquirer.prompt([
      { type: 'list', name: 'file', message: 'Pilih backup yang mau dihapus:', choices: backups },
    ]);
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: `Yakin hapus "${file}"?`, default: false },
    ]);
    if (confirm) {
      const result = backup.deleteBackup(file);
      result.ok ? logger.success('Backup dihapus.') : logger.error(result.errorMessage);
    } else {
      logger.info('Dibatalkan.');
    }
  }

  await afterAction(backupManagerMenu);
}

async function securityManagerMenu() {
  const action = await customMenu.showMenu('🔒 Security Manager (Audit)', [
    { key: 'firewall', label: 'Cek Status Firewall', hint: 'Lihat aturan firewall (ufw/iptables) yang lagi aktif di server. Cuma cek, tidak mengubah apapun.' },
    { key: 'ports', label: 'List Port Terbuka', hint: 'Lihat port mana saja yang lagi "mendengarkan" koneksi masuk, dan proses apa yang pakai.' },
    { key: 'fail2ban', label: 'Cek Fail2ban', hint: 'Fail2ban = program yang otomatis blokir IP yang mencurigakan (misal brute-force login). Cek apakah aktif.' },
    { key: 'ssh', label: 'Cek Setting SSH', hint: 'Cek apakah setting login SSH server ini sudah aman (root login, password auth, dll). Cuma cek, tidak mengubah apapun.' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await showMainMenu();
    return;
  }

  if (action === 'firewall') {
    const result = security.checkFirewall();
    result.ok
      ? logger.card(`🔥 Firewall (${result.tool})`, result.output.split('\n'), { color: 'green' })
      : logger.warn(result.errorMessage);
  } else if (action === 'ports') {
    const { ok, ports, error } = security.listOpenPorts();
    if (!ok) {
      logger.error(error);
    } else if (ports.length === 0) {
      logger.warn('Tidak ada port terbuka terdeteksi.');
    } else {
      ports.forEach((p) => logger.card(`🔌 Port ${p.port}`, [`Address: ${p.address}`, `Proses: ${p.process}`], { color: 'cyan' }));
    }
  } else if (action === 'fail2ban') {
    const result = security.checkFail2ban();
    result.ok
      ? logger.card('🛡️  Fail2ban', result.output.split('\n'), { color: 'green' })
      : logger.warn(result.errorMessage + ' (opsional, bisa diinstall: sudo apt install fail2ban)');
  } else if (action === 'ssh') {
    const result = security.checkSshConfig();
    if (!result.ok) {
      logger.warn(result.errorMessage);
    } else {
      const s = result.settings;
      const warnings = [];
      if (s.PermitRootLogin === 'yes') warnings.push('⚠️  PermitRootLogin masih "yes" - root bisa login SSH langsung, disarankan "no".');
      if (s.PasswordAuthentication === 'yes') warnings.push('⚠️  PasswordAuthentication masih "yes" - disarankan pakai SSH key + set ke "no".');

      logger.card(
        '🔑 SSH Config',
        [
          `PermitRootLogin: ${s.PermitRootLogin || '(default)'}`,
          `PasswordAuthentication: ${s.PasswordAuthentication || '(default)'}`,
          `Port: ${s.Port || '22 (default)'}`,
        ],
        { color: warnings.length > 0 ? 'yellow' : 'green' }
      );
      warnings.forEach((w) => logger.warn(w));
    }
  }

  await afterAction(securityManagerMenu);
}

async function logViewerMenu() {
  const source = await customMenu.showMenu('📜 Log Viewer', [
    { key: 'pm2', label: 'PM2 Logs (per app)', hint: 'Log dari aplikasi Node kamu sendiri (console.log, error crash, dll).' },
    { key: 'nginx', label: 'Nginx Error Log (per domain)', hint: 'Log error dari sisi web server buat 1 domain (misal 502 Bad Gateway, SSL error).' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (source === 'back') {
    await showMainMenu();
    return;
  }

  let result;
  let header;

  if (source === 'pm2') {
    const { ok, apps } = pm2.listApps();
    if (!ok || apps.length === 0) {
      logger.warn('Belum ada app PM2 untuk dilihat log-nya.');
      await afterAction(logViewerMenu);
      return;
    }
    const { selected } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selected',
        message: 'Pilih app:',
        choices: apps.map((a) => ({ name: `${a.name} (${a.owner})`, value: `${a.name}|${a.owner}` })),
      },
    ]);
    const [name, owner] = selected.split('|');
    header = `PM2 Logs: ${name}`;
    result = logviewer.getPm2Log(name, owner, 60);
  } else {
    const { ok, sites } = nginx.listSites();
    if (!ok || sites.length === 0) {
      logger.warn('Belum ada site nginx.');
      await afterAction(logViewerMenu);
      return;
    }
    const { file } = await inquirer.prompt([
      { type: 'list', name: 'file', message: 'Pilih site:', choices: sites.map((s) => ({ name: s.domain, value: s.file })) },
    ]);
    const site = sites.find((s) => s.file === file);
    const domain = site.domain.split(' ')[0];
    header = `Nginx Error Log: ${domain}`;
    result = logviewer.getNginxErrorLog(domain, 60);
  }

  if (!result.ok) {
    logger.error(result.errorMessage);
    await afterAction(logViewerMenu);
    return;
  }

  console.log(`\n${chalk.bold.cyan('━━━ ' + header + ' ━━━')}\n`);
  if (result.lines.length === 0) {
    logger.info('Log kosong, belum ada aktivitas tercatat.');
  } else {
    result.lines.forEach((line) => {
      const type = logviewer.classifyLine(line);
      if (type === 'error') console.log(chalk.redBright(`🔴 ${line}`));
      else if (type === 'warn') console.log(chalk.yellowBright(`🟡 ${line}`));
      else console.log(chalk.dim(`⚪ ${line}`));
    });
  }
  console.log(`\n${chalk.dim('Legenda: 🔴 error/fatal   🟡 warning   ⚪ info biasa')}\n`);

  await afterAction(logViewerMenu);
}


async function cleanupMenu() {
  logger.section('🧹 Bersihin Cache/Storage');
  diskCard('💽 Disk Sekarang');

  const mode = await customMenu.showMenu('Mau scan yang mana?', [
    { key: 'project', label: '📁 Cache Project (otomatis dari PM2)', hint: 'Ambil daftar project dari PM2 (online & offline), scan .next/cache & node_modules/.cache di path masing-masing. Nggak perlu ketik path manual.' },
    { key: 'home', label: '🏠 Scan Home User (manual)', hint: 'Ketik username, scan seluruh $HOME-nya - lebih lengkap (npm/yarn/pnpm/pip cache, log PM2) tapi lebih lama.' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (mode === 'back') {
    await showMainMenu();
    return;
  }

  let items;
  if (mode === 'project') {
    logger.info('⏳ Ambil daftar project dari PM2...');
    const pmResult = pm2.listApps();
    if (!pmResult.ok || pmResult.apps.length === 0) {
      logger.warn(pmResult.error || 'Nggak ada app PM2 ditemukan. Pastikan sudah ada project yang di-deploy/di-import.');
      await afterAction(cleanupMenu);
      return;
    }
    logger.info(`⏳ Scanning cache ${pmResult.apps.length} app PM2 (online & offline)...`);
    items = cleanup.scanProjectCaches(pmResult.apps);
  } else {
    const { username } = await inquirer.prompt([
      { type: 'input', name: 'username', message: 'Scan home folder user mana? (mis. www, catur):', validate: (v) => (v.trim() ? true : 'Nggak boleh kosong') },
    ]);
    logger.info(`⏳ Scanning home folder user "${username.trim()}"... (bisa agak lama kalau project-nya banyak)`);
    const scan = cleanup.scanUserCache(username.trim());
    if (!scan.ok) {
      logger.error(scan.errorMessage);
      await afterAction(cleanupMenu);
      return;
    }
    items = scan.items;
  }

  if (items.length === 0) {
    logger.success('Nggak ketemu cache/file gaguna yang signifikan (≥1MB).');
    await afterAction(cleanupMenu);
    return;
  }

  const sorted = items.slice().sort((a, b) => b.bytes - a.bytes);
  const totalBytes = sorted.reduce((sum, i) => sum + i.bytes, 0);
  logger.card(
    `📦 Found: ${sorted.length} item (total ${cleanup.formatBytes(totalBytes)})`,
    sorted.slice(0, 15).map((i) => `${cleanup.formatBytes(i.bytes).padStart(8)}  ${i.project ? `[${i.project}] ` : ''}${i.label} — ${i.path}`),
    { color: 'cyan' }
  );

  const { selected } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selected',
      message: 'Pilih yang mau dihapus (spasi = pilih, enter = lanjut):',
      choices: sorted.map((item, idx) => ({
        name: `${cleanup.formatBytes(item.bytes).padStart(8)}  ${item.project ? `[${item.project}] ` : ''}${item.label} — ${item.path}`,
        value: idx,
      })),
    },
  ]);

  if (selected.length === 0) {
    logger.info('Nggak ada yang dipilih. Dibatalkan.');
    await afterAction(cleanupMenu);
    return;
  }

  const toDelete = selected.map((idx) => sorted[idx]);
  const totalSelectedBytes = toDelete.reduce((sum, i) => sum + i.bytes, 0);
  logger.card(
    '⚠️  Konfirmasi Hapus',
    [`${toDelete.length} item, total ${cleanup.formatBytes(totalSelectedBytes)} akan DIHAPUS PERMANEN:`, ...toDelete.slice(0, 10).map((i) => `- ${i.path}`)],
    { color: 'yellow' }
  );
  const { confirm } = await inquirer.prompt([
    { type: 'confirm', name: 'confirm', message: `Yakin hapus ${toDelete.length} item ini? (nggak ada undo)`, default: false },
  ]);
  if (!confirm) {
    logger.info('Dibatalkan.');
    await afterAction(cleanupMenu);
    return;
  }

  let freedBytes = 0;
  let successCount = 0;
  for (const item of toDelete) {
    const result = cleanup.deletePath(item.owner, item.path, item.home);
    if (result.ok) {
      successCount++;
      freedBytes += item.bytes;
      logger.success(`Terhapus: ${item.path}`);
    } else {
      logger.error(`Gagal hapus ${item.path}: ${result.errorMessage}`);
    }
  }

  logger.success(`Selesai. ${successCount}/${toDelete.length} item berhasil dihapus.`);
  diskCard('💽 Disk After');
  logger.card('✅ Freed', [cleanup.formatBytes(freedBytes)], { color: 'green' });

  await afterAction(cleanupMenu);
}

/**
 * VPS Scanner: deteksi kondisi nyata server dan bandingkan dengan registry.
 * 4 komponen: Cari PM2 semua user, Cek Port (bedain Sistem/App), Cek API,
 * dan Cocokkan Registry - bisa dijalankan satu-satu atau sekaligus (Full Scan).
 */
async function vpsScannerMenu() {
  const action = await customMenu.showMenu('🔍 VPS Scanner', [
    { key: 'full', label: '🚀 Full Scan (Semua)', hint: 'Jalankan semua tahap sekaligus: PM2, Port, API, dan cocokkan ke Registry - laporan lengkap kondisi server.' },
    { key: 'pm2', label: 'Cari PM2 Semua User', hint: 'List semua app PM2 dari semua deploy_user yang terdaftar, dikelompokkan per user.' },
    { key: 'ports', label: 'Cek Port', hint: 'Bandingin port yang BENERAN kebuka di server (ss -tlnp) vs port yang tercatat di registry, plus dibedain mana punya Sistem dan mana punya App.' },
    { key: 'api', label: 'Cek API/Endpoint', hint: 'Request HTTP ke tiap project yang punya port, cek beneran ngasih respon atau nggak.' },
    { key: 'back', label: '↩️  Kembali' },
  ]);

  if (action === 'back') {
    await showMainMenu();
    return;
  }

  if (action === 'pm2') {
    const result = scanner.scanPm2Apps();
    if (!result.ok) {
      logger.error(result.errorMessage);
      await afterAction(vpsScannerMenu);
      return;
    }
    const owners = Object.keys(result.grouped);
    if (owners.length === 0) {
      logger.warn('Belum ada app PM2 ditemukan di user manapun.');
    } else {
      owners.forEach((owner) => {
        const lines = result.grouped[owner].map((a) => `${a.name}  [${a.status}]  port: ${a.port}`);
        logger.card(`👤 User: ${owner}`, lines, { color: 'cyan' });
      });
    }
    if (result.warnings.length > 0) result.warnings.forEach((w) => logger.warn(w));
    await afterAction(vpsScannerMenu);
    return;
  }

  if (action === 'ports') {
    logger.info('⏳ Scanning port terbuka di server...');
    const result = scanner.scanPorts();
    if (!result.ok) {
      logger.error(result.errorMessage);
      await afterAction(vpsScannerMenu);
      return;
    }
    renderPortScanResult(result);
    await afterAction(vpsScannerMenu);
    return;
  }

  if (action === 'api') {
    const portResult = scanner.scanPorts();
    if (!portResult.ok) {
      logger.error(portResult.errorMessage);
      await afterAction(vpsScannerMenu);
      return;
    }
    if (portResult.projectChecks.length === 0) {
      logger.warn('Belum ada project dengan port terdaftar di registry untuk dicek.');
      await afterAction(vpsScannerMenu);
      return;
    }
    logger.info('⏳ Request ke tiap endpoint project, mohon tunggu...');
    const apiResults = await scanner.scanApiHealth(portResult.projectChecks);
    renderApiScanResult(apiResults);
    await afterAction(vpsScannerMenu);
    return;
  }

  if (action === 'full') {
    logger.info('⏳ Full Scan berjalan: PM2 → Port → API → Cocokkan Registry (bisa beberapa detik)...\n');
    const result = await scanner.scanAll();
    if (!result.ok) {
      logger.error(result.errorMessage);
      await afterAction(vpsScannerMenu);
      return;
    }

    logger.section('1️⃣  PM2 - Semua User');
    const owners = Object.keys(
      result.pm2.apps.reduce((acc, a) => ({ ...acc, [a.owner]: true }), {})
    );
    if (owners.length === 0) {
      logger.warn('Belum ada app PM2 ditemukan.');
    } else {
      owners.forEach((owner) => {
        const lines = result.pm2.apps.filter((a) => a.owner === owner).map((a) => `${a.name}  [${a.status}]  port: ${a.port}`);
        logger.card(`👤 User: ${owner}`, lines, { color: 'cyan' });
      });
    }

    logger.section('2️⃣  Port');
    renderPortScanResult(result.ports);

    logger.section('3️⃣  API/Endpoint');
    renderApiScanResult(result.api);

    logger.section('4️⃣  Cocokkan Registry');
    if (result.registryMatches.length === 0) {
      logger.warn('Belum ada project terdaftar di registry.');
    } else {
      result.registryMatches.forEach((m) => {
        const lines = [
          `Folder  : ${m.folderExists ? '✅ ada' : '❌ tidak ditemukan'}`,
          `PM2     : ${m.pm2Found ? `✅ ada (status: ${m.pm2Status})` : '❌ tidak ada di PM2'}`,
          `Port    : ${m.portMatch === null ? '➖ n/a (project ini nggak pakai port)' : m.portMatch ? '✅ cocok' : '❌ TIDAK cocok dengan port asli di server'}`,
          `Domain  : ${m.domainMatch === null ? '➖ n/a (project ini nggak punya domain)' : m.domainMatch ? '✅ nginx sudah ngarah ke port yang benar' : '❌ TIDAK cocok (nginx nggak ada/ngarah ke port lain)'}`,
        ];
        const anyProblem = m.folderExists === false || m.pm2Found === false || m.portMatch === false || m.domainMatch === false;
        logger.card(`${anyProblem ? '⚠️ ' : '✅'} ${m.name}`, lines, { color: anyProblem ? 'yellow' : 'green' });
      });
    }

    if (result.orphanPm2Apps.length > 0) {
      logger.card(
        '⚠️  App PM2 Jalan Tapi Belum Terdaftar di Registry',
        result.orphanPm2Apps.map((a) => `${a.name} (user: ${a.owner}, port: ${a.port}) - daftarkan lewat menu 1. Import Project ke Registry`),
        { color: 'yellow' }
      );
    }

    await afterAction(vpsScannerMenu);
    return;
  }
}

/**
 * Render hasil scanPorts() jadi card - dipakai baik dari menu "Cek Port"
 * standalone maupun dari dalam Full Scan, biar formatnya konsisten.
 */
function renderPortScanResult(result) {
  if (result.projectChecks.length === 0) {
    logger.warn('Belum ada project dengan port terdaftar di registry.');
  } else {
    result.projectChecks.forEach((c) => {
      if (c.open) {
        logger.card(`✅ ${c.name}`, [`Port: ${c.port}`, 'Status: Terbuka', `Proses: ${c.categoryLabel}`], { color: 'green' });
      } else {
        logger.card(
          `🔴 ${c.name}`,
          [`Port: ${c.port}`, 'Status: TIDAK terbuka di server - app kemungkinan mati/crash walau PM2 bilang online'],
          { color: 'red' }
        );
      }
    });
  }

  if (result.orphanPorts.length > 0) {
    logger.card(
      '⚠️  Port Terbuka Tidak Dikenal Registry',
      result.orphanPorts.map((p) => `Port ${p.port}  -  ${p.address}  -  ${p.label}`),
      { color: 'yellow' }
    );
  } else {
    logger.info('Semua port terbuka di server sudah cocok dengan project terdaftar.');
  }
}

/**
 * Render hasil scanApiHealth() jadi card - dipakai baik dari menu "Cek API"
 * standalone maupun dari dalam Full Scan.
 */
function renderApiScanResult(apiResults) {
  if (apiResults.length === 0) {
    logger.warn('Belum ada project dengan port terdaftar untuk dicek API-nya.');
    return;
  }
  apiResults.forEach((r) => {
    if (r.reachable) {
      const level = r.status >= 200 && r.status < 400 ? 'green' : 'yellow';
      logger.card(`${level === 'green' ? '✅' : '⚠️ '} ${r.name}`, [`Port: ${r.port}`, `HTTP Status: ${r.status}`], { color: level });
    } else {
      logger.card(`🔴 ${r.name}`, [`Port: ${r.port}`, `Tidak bisa diakses: ${r.note}`], { color: 'red' });
    }
  });
}

async function afterAction(currentMenuFn) {

  const items = currentMenuFn
    ? [
        { key: 'repeat', label: '🔁 Menu ini lagi' },
        { key: 'menu', label: '🏠 Menu Utama' },
        { key: 'exit', label: '🚪 Keluar' },
      ]
    : [
        { key: 'menu', label: '🏠 Menu Utama' },
        { key: 'exit', label: '🚪 Keluar' },
      ];

  const next = await customMenu.showMenu('Lanjut ke mana?', items);

  if (next === 'repeat' && currentMenuFn) await currentMenuFn();
  else if (next === 'menu') await showMainMenu();
  else {
    logger.info('Sampai jumpa!');
    process.exit(0);
  }
}

// Alias biar caller lama yang belum sempat diupdate tetap jalan (fallback ke Menu Utama/Keluar tanpa opsi repeat)
async function backToMain() {
  await afterAction(null);
}

module.exports = { showMainMenu };