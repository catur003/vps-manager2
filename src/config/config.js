const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJSON, withFileLock } = require('../utils/safeFile');

const CONFIG_PATH = process.env.VPS_MANAGER_CONFIG_PATH || path.join(__dirname, '..', '..', 'data', 'config.json');
const API_KEY_MASTER_PATH = path.join(path.dirname(CONFIG_PATH), '.api-key-master');
const API_KEY_LOCK_PATH = path.join(path.dirname(CONFIG_PATH), '.api-keys.lock');

const DEFAULT_CONFIG = {
  deploy_user: 'ubuntu',
  nginx_user: 'www-data',
  default_folder: '/opt/apps',
  docker_projects_dir: '/opt/docker',
  git_branch: 'main',
  starting_port: 3000,
  nginx_conf_dir: '/etc/nginx/sites-available',
  nginx_binary: '/usr/sbin/nginx',
  certbot_webroot: '/opt/certbot',
  certbot_email: '',
  db_root_user: 'root',
  db_root_password: '',
  pg_root_user: 'postgres',
  pg_root_password: '',
  backup_dir: '/www/backup_manager',
  backup_retention_days: 7,
  nginx_log_dir: '/var/log/nginx',
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
  // Config buat REST API (bot/mobile/web GUI). `key_hash`+`key_salt` adalah
  // key legacy. Key bernama di `keys` menyimpan hash untuk autentikasi dan
  // ciphertext AES-GCM agar operator bisa melakukan reveal setelah verifikasi
  // password; master enkripsinya disimpan terpisah dengan permission 600.
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
    keys: [],
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

function getApiKeyMaster() {
  try {
    const key = Buffer.from(fs.readFileSync(API_KEY_MASTER_PATH, 'utf8').trim(), 'hex');
    if (key.length !== 32) throw new Error('API key encryption master tidak valid.');
    return key;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const key = crypto.randomBytes(32);
    try {
      const fd = fs.openSync(API_KEY_MASTER_PATH, 'wx', 0o600);
      fs.writeFileSync(fd, key.toString('hex') + '\n');
      fs.closeSync(fd);
      return key;
    } catch (createErr) {
      if (createErr.code !== 'EEXIST') throw createErr;
      return Buffer.from(fs.readFileSync(API_KEY_MASTER_PATH, 'utf8').trim(), 'hex');
    }
  }
}

function encryptApiKey(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getApiKeyMaster(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { encrypted: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function decryptApiKey(record) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', getApiKeyMaster(), Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.encrypted, 'base64')), decipher.final()]).toString('utf8');
}

function apiKeyMetadata(record) {
  return { id: record.id, name: record.name, createdAt: record.createdAt, revealable: true, prefix: `vps_${record.id}_` };
}

function listApiKeys() {
  const cfg = loadConfig();
  const keys = (cfg.api?.keys || []).map(apiKeyMetadata);
  if (cfg.api?.key_hash && cfg.api?.key_salt) {
    keys.unshift({ id: 'legacy', name: 'Legacy API Key', createdAt: null, revealable: false, prefix: null });
  }
  return keys;
}

function createNamedApiKey(name) {
  const cleanName = String(name || '').trim();
  if (!cleanName || cleanName.length > 60 || /[\r\n]/.test(cleanName)) {
    const err = new Error('Nama API key wajib diisi dan maksimal 60 karakter.');
    err.code = 'INVALID_API_KEY_NAME';
    throw err;
  }
  return withFileLock(API_KEY_LOCK_PATH, () => {
    const cfg = loadConfig();
    const keys = cfg.api?.keys || [];
    if (keys.length >= 50) throw new Error('Maksimal 50 API key.');
    if (keys.some((item) => item.name.toLowerCase() === cleanName.toLowerCase())) {
      const err = new Error('Nama API key sudah dipakai.');
      err.code = 'API_KEY_NAME_EXISTS';
      throw err;
    }
    const id = crypto.randomBytes(6).toString('hex');
    const apiKey = `vps_${id}_${crypto.randomBytes(32).toString('base64url')}`;
    const salt = crypto.randomBytes(16).toString('hex');
    const record = {
      id,
      name: cleanName,
      keySalt: salt,
      keyHash: crypto.scryptSync(apiKey, salt, 64).toString('hex'),
      ...encryptApiKey(apiKey),
      createdAt: new Date().toISOString(),
    };
    cfg.api = { ...(cfg.api || DEFAULT_CONFIG.api), keys: [...keys, record] };
    saveConfig(cfg);
    return { ...apiKeyMetadata(record), apiKey };
  }, { timeoutMs: 15000, staleMs: 60000 });
}

function revealApiKey(id) {
  const record = (loadConfig().api?.keys || []).find((item) => item.id === id);
  if (!record) {
    const err = new Error(id === 'legacy' ? 'Key lama tidak bisa direveal karena plaintext tidak pernah disimpan.' : 'API key tidak ditemukan.');
    err.code = id === 'legacy' ? 'API_KEY_NOT_REVEALABLE' : 'API_KEY_NOT_FOUND';
    throw err;
  }
  return { ...apiKeyMetadata(record), apiKey: decryptApiKey(record) };
}

function revokeApiKey(id) {
  return withFileLock(API_KEY_LOCK_PATH, () => {
    const cfg = loadConfig();
    cfg.api = { ...(cfg.api || DEFAULT_CONFIG.api) };
    if (id === 'legacy') {
      if (!cfg.api.key_hash) return false;
      cfg.api.key_hash = '';
      cfg.api.key_salt = '';
    } else {
      const keys = cfg.api.keys || [];
      const filtered = keys.filter((item) => item.id !== id);
      if (filtered.length === keys.length) return false;
      cfg.api.keys = filtered;
    }
    saveConfig(cfg);
    return true;
  }, { timeoutMs: 15000, staleMs: 60000 });
}

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
  const apiCfg = cfg.api || {};
  const parts = String(candidateKey).match(/^vps_([a-f0-9]{12})_/);
  if (parts) {
    const record = (apiCfg.keys || []).find((item) => item.id === parts[1]);
    if (!record) return false;
    const candidateHash = crypto.scryptSync(candidateKey, record.keySalt, 64);
    const storedHash = Buffer.from(record.keyHash, 'hex');
    return candidateHash.length === storedHash.length && crypto.timingSafeEqual(candidateHash, storedHash);
  }
  const { key_hash: keyHash, key_salt: keySalt } = apiCfg;
  if (!keyHash || !keySalt) return false;
  const candidateHash = crypto.scryptSync(candidateKey, keySalt, 64);
  const storedHash = Buffer.from(keyHash, 'hex');
  return candidateHash.length === storedHash.length && crypto.timingSafeEqual(candidateHash, storedHash);
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
  listApiKeys,
  createNamedApiKey,
  revealApiKey,
  revokeApiKey,
  verifyApiKey,
  CONFIG_PATH,
};
