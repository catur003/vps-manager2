const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJSON } = require('../utils/safeFile');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'data', 'config.json');

const DEFAULT_CONFIG = {
  deploy_user: 'www',
  nginx_user: 'www-data',
  default_folder: '/www/wwwroot',
  git_branch: 'main',
  starting_port: 3000,
  nginx_conf_dir: '/www/server/panel/vhost/nginx',
  nginx_binary: '/www/server/nginx/sbin/nginx',
  certbot_webroot: '/var/www/certbot',
  certbot_email: '',
  db_root_user: 'root',
  db_root_password: '',
  pg_root_user: 'postgres',
  pg_root_password: '',
  backup_dir: '/www/backup_manager',
  backup_retention_days: 7,
  nginx_log_dir: '/www/wwwlogs',
  // Path file credentials Cloudflare (format INI, `dns_cloudflare_api_token
  // = <token>`) buat certbot plugin `dns-cloudflare` - dipakai buat wildcard
  // SSL (DNS-01 challenge, satu-satunya cara certbot bisa nerbitin cert
  // `*.domain.com`). `null` = belum di-setup, fitur wildcard nolak jalan
  // sampai ini keisi lewat POST /ssl/cloudflare-setup. File INI-nya SENDIRI
  // (bukan token mentahnya) yang chmod 600 - config.json ini cuma nyimpen
  // PATH-nya, bukan token asli, biar gak ada 2 salinan token tersebar.
  cloudflare_credentials_path: null,
  // User OS lain (di luar deploy_user & user yang punya project di registry)
  // yang PM2-nya juga mau dipantau panel - buat app yang di-start manual di
  // luar alur deploy tool ini (mis. proses lama yang udah jalan sebelum
  // panel ada), BUKAN buat kasih akses baru apapun - cuma nambah scope
  // `pm2 jlist` yang di-loop di pm2.js getRelevantUsers()/listApps().
  additional_pm2_users: [],
  runtime_default: {
    node: '20.9.0',
    php: '8.2',
  },
  // Config buat REST API (bot Telegram/mobile/web GUI). `key_hash`+`key_salt`
  // itu hasil scrypt dari API key asli - key PLAINTEXT-nya CUMA ditampilin
  // sekali pas di-generate (lihat generateApiKey()), gak pernah disimpen.
  api: {
    port: 4001,
    // Direct HTTPS dipakai fresh install yang belum punya domain.
    public_port: 4001,
    public_url: '',
    direct_https: {
      enabled: false,
      key_path: '',
      cert_path: '',
    },
    key_hash: '',
    key_salt: '',
  },
  // Daftar akun GitHub tersimpan: [{ label, username, token }]. `token` idealnya
  // Personal Access Token (PAT) dengan scope minimal ("repo" doang buat private
  // repo) - BUKAN password akun GitHub asli (GitHub sendiri sudah nggak
  // menerima password biasa buat operasi git via HTTPS). Disimpan di file
  // config.json yang sama (permission 600, lihat ensureConfigFile()).
  github_accounts: [],
  // API Token Cloudflare (scoped ke Zone:Cache Purge + Zone:Firewall Services
  // Edit, dibuat manual di Cloudflare dashboard) - dipakai fitur purge cache
  // & toggle Under Attack Mode per domain dari halaman Domains. `null` =
  // belum di-setup, fitur ini nolak jalan sampai diisi lewat Settings.
  cloudflare_api_token: null,
};

function ensureConfigFile() {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    atomicWriteJSON(CONFIG_PATH, DEFAULT_CONFIG, 0o600);
  }
  // Defense-in-depth: paksa permission 600 tiap kali dipastikan ada, buat
  // jaga-jaga file lama (dibuat sebelum fix ini) yang masih permission default.
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch (err) {
    // biarin lanjut walau gagal chmod (misal filesystem yang nggak support),
    // daripada bikin seluruh tool berhenti cuma gara-gara ini
  }
}

function loadConfig() {
  ensureConfigFile();
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

function saveConfig(config) {
  ensureConfigFile();
  atomicWriteJSON(CONFIG_PATH, config, 0o600);
}

function updateConfig(key, value) {
  const config = loadConfig();
  config[key] = value;
  saveConfig(config);
  return config;
}

function listGithubAccounts() {
  return loadConfig().github_accounts || [];
}

function addGithubAccount({ label, username, token }) {
  const cfg = loadConfig();
  const accounts = (cfg.github_accounts || []).filter((a) => a.label !== label);
  accounts.push({ label, username, token });
  saveConfig({ ...cfg, github_accounts: accounts });
}

function removeGithubAccount(label) {
  const cfg = loadConfig();
  const accounts = (cfg.github_accounts || []).filter((a) => a.label !== label);
  saveConfig({ ...cfg, github_accounts: accounts });
}

/**
 * Generate API key baru buat REST API (bot/mobile/web). Cuma HASH-nya
 * (scrypt + salt random) yang disimpen ke config.json - key plaintext-nya
 * di-return SEKALI ke caller (buat ditampilin ke user), gak pernah ditulis
 * ke disk. Manggil ini ulang otomatis nge-invalidate key lama (hash lama
 * ketimpa), jadi ini juga fungsi buat "rotate key".
 */
function generateApiKey() {
  const plainKey = crypto.randomBytes(32).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(plainKey, salt, 64).toString('hex');

  const cfg = loadConfig();
  cfg.api = { ...(cfg.api || DEFAULT_CONFIG.api), key_hash: hash, key_salt: salt };
  saveConfig(cfg);

  return plainKey;
}

/**
 * Cek API key dari request cocok apa nggak sama hash tersimpan.
 * Pakai timingSafeEqual biar gak bocorin info lewat timing attack.
 */
function verifyApiKey(candidateKey) {
  if (!candidateKey) return false;
  const cfg = loadConfig();
  const { key_hash: keyHash, key_salt: keySalt } = cfg.api || {};
  if (!keyHash || !keySalt) return false;

  const candidateHash = crypto.scryptSync(candidateKey, keySalt, 64);
  const storedHash = Buffer.from(keyHash, 'hex');
  if (candidateHash.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(candidateHash, storedHash);
}

module.exports = {
  loadConfig,
  saveConfig,
  updateConfig,
  DEFAULT_CONFIG,
  listGithubAccounts,
  addGithubAccount,
  removeGithubAccount,
  generateApiKey,
  verifyApiKey,
  CONFIG_PATH,
};
