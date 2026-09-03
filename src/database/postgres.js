const crypto = require('crypto');
const shell = require('../utils/shell');
const config = require('../config/config');

const SAFE_NAME = /^[a-zA-Z0-9_]+$/;

function isValidName(name) {
  return typeof name === 'string' && SAFE_NAME.test(name) && name.length <= 63;
}

function pgCreds() {
  const cfg = config.loadConfig();
  return { user: cfg.pg_root_user || 'postgres', password: cfg.pg_root_password || '' };
}

function escapeSqlString(str) {
  return str.replace(/'/g, "''");
}

function generatePassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 20);
}

function interpretPgError(rawMessage) {
  const msg = (rawMessage || '').trim();
  if (!msg) return 'Terjadi error saat menjalankan query PostgreSQL (tidak ada detail error).';
  if (/could not connect/i.test(msg) || /Connection refused/i.test(msg)) {
    return `Gagal konek ke server PostgreSQL. Cek apakah service postgresql jalan, dan pg_root_user/pg_root_password di Configuration bener. (${msg})`;
  }
  if (/password authentication failed/i.test(msg)) {
    return `Login PostgreSQL ditolak (user/password salah). Cek pg_root_user/pg_root_password di Configuration. (${msg})`;
  }
  if (/permission denied/i.test(msg)) {
    return `User PostgreSQL ini nggak punya izin buat aksi ini. (${msg})`;
  }
  if (/does not exist/i.test(msg)) {
    return `Database/user tidak ditemukan. (${msg})`;
  }
  return msg;
}

/**
 * Jalankan SQL via `psql` TCP (127.0.0.1) + password lewat env var PGPASSWORD
 * (BUKAN command-line flag) - pola sama persis dengan database.js (MySQL):
 * execFileSync (argv terpisah, bukan shell string), password gak pernah
 * nongol di `ps aux`.
 */
function runSQL(sql, { database = 'postgres', tuplesOnly = false, maxBuffer, timeoutMs } = {}) {
  if (!shell.commandExists('psql')) {
    return { ok: false, notInstalled: true, errorMessage: 'PostgreSQL belum terinstall di server ini. Install dulu lewat halaman Tools / Installer.' };
  }
  const { user, password } = pgCreds();
  const args = ['-h', '127.0.0.1', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1'];
  if (tuplesOnly) args.push('-t', '-A'); // -t: tuples only (no header), -A: unaligned (no padding) - gampang di-parse
  args.push('-c', sql);

  const env = { ...process.env };
  if (password) env.PGPASSWORD = password;

  const result = shell.runArgs('psql', args, { silent: true, maxBuffer, timeoutMs: timeoutMs || 30 * 1000, env });
  if (!result.ok) return { ...result, errorMessage: interpretPgError(result.errorMessage) };
  return result;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * List semua database non-template (buang "postgres" server default & 2
 * template bawaan) - dengan ukuran per-database, biar sama informatif kayak
 * Database page (MySQL).
 */
function listDatabases() {
  const result = runSQL(
    "SELECT datname, pg_database_size(datname) FROM pg_database WHERE datistemplate = false AND datname != 'postgres' ORDER BY datname;",
    { tuplesOnly: true },
  );
  if (!result.ok) return { ok: false, databases: [], error: result.errorMessage, notInstalled: result.notInstalled };

  const databases = result.output.split('\n').filter(Boolean).map((line) => {
    const [name, bytes] = line.split('|');
    return { name, sizeBytes: parseInt(bytes, 10) || 0, sizeLabel: formatBytes(parseInt(bytes, 10) || 0) };
  });
  return { ok: true, databases };
}

function getServerVersion() {
  const result = runSQL('SHOW server_version;', { tuplesOnly: true });
  return result.ok ? result.output.trim() : null;
}

function testConnection() {
  const result = runSQL('SELECT 1;');
  return result.ok ? { ok: true } : { ok: false, errorMessage: result.errorMessage };
}

/**
 * Bikin database + role baru sekaligus (role = database owner, satu-satu
 * biar konsisten sama pola MySQL createDatabase - 1 database = 1 user).
 */
function createDatabase(dbName, dbUser, customPassword) {
  if (!isValidName(dbName)) return { ok: false, errorMessage: 'Nama database tidak valid (hanya huruf/angka/underscore).' };
  if (!isValidName(dbUser)) return { ok: false, errorMessage: 'Nama user tidak valid (hanya huruf/angka/underscore).' };

  const password = customPassword && customPassword.trim() !== '' ? customPassword : generatePassword();
  const escapedPassword = escapeSqlString(password);

  const createUserResult = runSQL(`CREATE USER "${dbUser}" WITH PASSWORD '${escapedPassword}';`);
  if (!createUserResult.ok) return { ok: false, errorMessage: createUserResult.errorMessage };

  const createDbResult = runSQL(`CREATE DATABASE "${dbName}" OWNER "${dbUser}";`);
  if (!createDbResult.ok) {
    // rollback: user kosong yang gagal dipasangin database dibuang lagi,
    // biar gak numpuk role "yatim" tanpa database
    runSQL(`DROP USER IF EXISTS "${dbUser}";`);
    return { ok: false, errorMessage: createDbResult.errorMessage };
  }

  const grantResult = runSQL(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}";`);
  if (!grantResult.ok) return { ok: false, errorMessage: grantResult.errorMessage };

  return { ok: true, dbName, dbUser, password };
}

function resetPassword(dbUser, customPassword) {
  if (!isValidName(dbUser)) return { ok: false, errorMessage: 'Nama user tidak valid.' };
  const password = customPassword && customPassword.trim() !== '' ? customPassword : generatePassword();
  const escapedPassword = escapeSqlString(password);

  const result = runSQL(`ALTER USER "${dbUser}" WITH PASSWORD '${escapedPassword}';`);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true, dbUser, password };
}

/**
 * Hapus database + role-nya. WAJIB putus semua koneksi aktif ke database
 * itu dulu (`pg_terminate_backend`) - PostgreSQL nolak DROP DATABASE kalau
 * masih ada 1 aja koneksi aktif ("database is being accessed by other
 * users"), beda dari MySQL yang boleh drop walau masih ada koneksi.
 */
function dropDatabase(dbName, dbUser) {
  if (!isValidName(dbName)) return { ok: false, errorMessage: 'Nama database tidak valid.' };

  runSQL(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${escapeSqlString(dbName)}' AND pid != pg_backend_pid();`);

  const dropDbResult = runSQL(`DROP DATABASE IF EXISTS "${dbName}";`);
  if (!dropDbResult.ok) return { ok: false, errorMessage: dropDbResult.errorMessage };

  if (dbUser && isValidName(dbUser)) {
    runSQL(`DROP USER IF EXISTS "${dbUser}";`);
  }
  return { ok: true };
}

module.exports = {
  isValidName,
  listDatabases,
  createDatabase,
  dropDatabase,
  resetPassword,
  testConnection,
  getServerVersion,
  formatBytes,
};
