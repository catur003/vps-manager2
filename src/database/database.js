const crypto = require('crypto');
const shell = require('../utils/shell');
const config = require('../config/config');

const SAFE_NAME = /^[a-zA-Z0-9_]+$/;

function mysqlCreds() {
  const cfg = config.loadConfig();
  return { user: cfg.db_root_user, password: cfg.db_root_password };
}

/**
 * Ubah pesan error mentah dari MySQL CLI jadi pesan yang jelas soal
 * "gagal konek ke server" vs "konek berhasil tapi akses ditolak" (permission),
 * biar operator langsung tau harus benerin kredensial atau grant.
 */
function interpretMysqlError(rawMessage) {
  const msg = (rawMessage || '').trim();
  if (!msg) return 'Terjadi error saat menjalankan query MySQL (tidak ada detail error).';

  if (/Can't connect/i.test(msg) || /ERROR 200[0-9]/i.test(msg)) {
    return `Gagal konek ke server MySQL. Cek apakah service MySQL/MariaDB jalan, dan db_root_user/db_root_password di Configuration bener. (${msg})`;
  }
  if (/Access denied for user/i.test(msg) && /using password/i.test(msg)) {
    return `Login MySQL ditolak (user/password salah). Cek db_root_user/db_root_password di Configuration. (${msg})`;
  }
  if (/Access denied for user/i.test(msg) && /to database/i.test(msg)) {
    return `User MySQL ini nggak punya akses ke database ini (permission kurang). (${msg})`;
  }
  if (/command denied to user/i.test(msg)) {
    return `User MySQL ini nggak punya izin buat query ini di tabel ini (permission kurang). (${msg})`;
  }
  if (/GRANT OPTION/i.test(msg)) {
    return `db_root_user tidak punya "WITH GRANT OPTION", jadi nggak bisa nge-GRANT privilege ke user lain. Login sebagai root MySQL asli dan jalankan: GRANT ALL PRIVILEGES ON *.* TO 'db_root_user'@'localhost' WITH GRANT OPTION; (ganti db_root_user sesuai Configuration). (${msg})`;
  }
  if (/Unknown database/i.test(msg)) {
    return `Database tidak ditemukan. (${msg})`;
  }
  return msg;
}

/**
 * @param {string} sql
 * @param {object} [opts]
 * @param {boolean} [opts.vertical] - pakai format vertical (-E), 1 kolom per baris,
 *   lebih enak dibaca di layar HP daripada tabel grid yang lebar.
 * @param {boolean} [opts.skipHeader] - pakai -N, buang baris header kolom
 *   (buat query yang hasilnya cuma mau dipakai sebagai array, misal SHOW TABLES).
 * @param {number} [opts.maxBuffer] - override default 1MB buffer punya execSync,
 *   buat jaga-jaga query yang hasilnya bisa lumayan besar sebelum sempat dipotong.
 * @param {number} [opts.timeoutMs] - override default 30 detik. Query MySQL
 *   normalnya cepat (milidetik-detik); default ini jaga-jaga kalau server
 *   MySQL nge-lock/nyangkut, biar gak nunggu selamanya kayak kasus Bug #6.
 *
 * PENTING - keamanan: dipanggil pakai shell.runArgs() (execFileSync, BUKAN
 * execSync/shell string) dan password dikirim lewat env var MYSQL_PWD,
 * BUKAN diselipkan ke command string. Ini WAJIB karena `sql` (lewat
 * createDatabase/resetPassword) dan `password` (dari body POST /database)
 * bisa berasal dari request API yang tidak divalidasi format bebasnya -
 * kalau masih dibangun sebagai satu string command lalu dieksekusi lewat
 * shell (execSync), isi `password`/`sql` yang mengandung `$(...)` bisa
 * dieksekusi shell SEBELUM sempat dibaca `mysql` sama sekali (command
 * injection, bukan cuma SQL injection - dibuktikan lewat PoC nyata, bukan
 * cuma dugaan). Dengan execFileSync, `sql` dikirim sebagai SATU argv utuh
 * ke proses `mysql`, tidak pernah melewati parsing shell sama sekali.
 */
function runSQL(sql, opts = {}) {
  const { user, password } = mysqlCreds();
  const args = ['-h', '127.0.0.1', '-P', '3306', '-u', user];
  if (opts.vertical) args.push('-E');
  if (opts.skipHeader) args.push('-N');
  args.push('-e', sql);

  const env = { ...process.env };
  if (password) env.MYSQL_PWD = password; // hindari password nongol di `ps aux` lewat flag -p

  const result = shell.runArgs('mysql', args, {
    silent: true,
    maxBuffer: opts.maxBuffer,
    timeoutMs: opts.timeoutMs || 30 * 1000,
    env,
  });
  if (!result.ok) {
    return { ...result, errorMessage: interpretMysqlError(result.errorMessage) };
  }
  return result;
}

function generatePassword(length = 20) {
  return crypto.randomBytes(length).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, length);
}

function isValidName(name) {
  return typeof name === 'string' && SAFE_NAME.test(name);
}

/**
 * Escape value buat ditempel ke DALAM string literal SQL yang dibungkus
 * kutip TUNGGAL (mis. `IDENTIFIED BY '${escaped}'`). Dipakai KHUSUS untuk
 * value yang gak bisa divalidasi lewat whitelist regex kayak isValidName()
 * (mis. password - boleh mengandung karakter apa aja). Escape backslash
 * DULU baru kutip tunggal (urutan penting - kalau kebalik, backslash hasil
 * escape kutip tunggal ikut ke-escape lagi jadi dobel).
 *
 * FIX (SQL injection): createDatabase()/resetPassword() sebelumnya nempelin
 * password APA ADANYA ke SQL (`IDENTIFIED WITH mysql_native_password BY
 * '${password}'`) - dikirim dari body request TANPA validasi/escape sama
 * sekali (beda dari dbName/dbUser yang sudah dijaga isValidName()). Password
 * berisi kutip tunggal (mis. `x' ; DROP DATABASE mysql; -- `) bisa keluar
 * dari string literal dan nambahin statement SQL lain yang BENERAN
 * dieksekusi oleh db_root_user (yang notabene emang perlu GRANT OPTION buat
 * fitur ini) - dampaknya bisa sampe bikin user MySQL admin baru atau hapus
 * database lain.
 */
function escapeSqlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * List semua database (kecuali database sistem bawaan MySQL).
 */
function listDatabases() {
  const result = runSQL('SHOW DATABASES;');
  if (!result.ok) return { ok: false, databases: [], error: result.errorMessage };

  const systemDbs = ['Database', 'information_schema', 'mysql', 'performance_schema', 'sys'];
  const databases = result.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !systemDbs.includes(l));

  return { ok: true, databases };
}

/**
 * Validasi database "beneran ada" - dipakai SEBELUM nama database dipakai di
 * SQL manapun (browse, backup, export, dll), bukan cuma cek format regex.
 * Nama database MySQL nggak bisa di-parameterize kayak value biasa, jadi
 * whitelist dari SHOW DATABASES ini satu-satunya cara aman.
 */
function validateDatabaseName(dbName) {
  if (!isValidName(dbName)) {
    return { valid: false, reason: 'Nama database tidak valid (hanya huruf/angka/underscore).' };
  }
  const { ok, databases, error } = listDatabases();
  if (!ok) return { valid: false, reason: error || 'Gagal ambil daftar database buat validasi.' };
  if (!databases.includes(dbName)) return { valid: false, reason: `Database "${dbName}" tidak ditemukan.` };
  return { valid: true };
}

/**
 * List semua tabel di satu database. Nama db divalidasi dulu (exist check).
 */
function listTables(dbName) {
  const dbCheck = validateDatabaseName(dbName);
  if (!dbCheck.valid) return { ok: false, tables: [], errorMessage: dbCheck.reason };

  const result = runSQL(`SHOW TABLES FROM \`${dbName}\`;`, { skipHeader: true });
  if (!result.ok) return { ok: false, tables: [], errorMessage: result.errorMessage };

  const tables = result.output.split('\n').map((l) => l.trim()).filter(Boolean);
  return { ok: true, tables };
}

/**
 * Validasi tabel "beneran ada" di database itu - sama prinsipnya kayak
 * validateDatabaseName, whitelist dari SHOW TABLES.
 */
function validateTableName(dbName, tableName) {
  if (!isValidName(tableName)) {
    return { valid: false, reason: 'Nama tabel tidak valid (hanya huruf/angka/underscore).' };
  }
  const dbCheck = validateDatabaseName(dbName);
  if (!dbCheck.valid) return dbCheck;

  const { ok, tables, errorMessage } = listTables(dbName);
  if (!ok) return { valid: false, reason: errorMessage || 'Gagal ambil daftar tabel buat validasi.' };
  if (!tables.includes(tableName)) {
    return { valid: false, reason: `Tabel "${tableName}" tidak ditemukan di database "${dbName}".` };
  }
  return { valid: true };
}

/**
 * Struktur kolom sebuah tabel (nama, tipe, null, key, default, extra).
 * Output mysql CLI buat DESCRIBE itu tab-separated per baris - di-parse jadi
 * object per kolom di sini, BUKAN didump mentah, biar caller (mainMenu) bisa
 * format ulang jadi tabel rata (fixed-width) sendiri.
 */
function describeTable(dbName, tableName) {
  const check = validateTableName(dbName, tableName);
  if (!check.valid) return { ok: false, errorMessage: check.reason };

  const result = runSQL(`DESCRIBE \`${dbName}\`.\`${tableName}\`;`, { skipHeader: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  const columns = result.output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      return {
        field: parts[0] || '',
        type: parts[1] || '',
        nullable: parts[2] || '',
        key: parts[3] || '',
        default: parts[4] || '',
        extra: parts[5] || '',
      };
    });

  return { ok: true, columns };
}

/**
 * Jumlah total baris di tabel (buat konteks, soalnya preview cuma nampilin
 * PREVIEW_LIMIT baris).
 */
function countRows(dbName, tableName) {
  const check = validateTableName(dbName, tableName);
  if (!check.valid) return { ok: false, errorMessage: check.reason };

  const result = runSQL(`SELECT COUNT(*) AS total FROM \`${dbName}\`.\`${tableName}\`;`, { skipHeader: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true, total: parseInt(result.output.trim(), 10) || 0 };
}

const PREVIEW_LIMIT = 10;
const FIELD_TRUNCATE_LENGTH = 200;

function truncateFieldValue(value) {
  if (value.length <= FIELD_TRUNCATE_LENGTH) return value;
  return `${value.slice(0, FIELD_TRUNCATE_LENGTH)}... (dipotong, total ${value.length} karakter)`;
}

/**
 * Preview isi tabel (LIMIT PREVIEW_LIMIT baris), format vertical (1 kolom per
 * baris) biar kebaca di layar HP, dan tiap value kolom yang kepanjangan
 * dipotong ke FIELD_TRUNCATE_LENGTH karakter (dengan keterangan, bukan
 * kepotong diam-diam).
 *
 * Catatan: kalau ada value yang isinya newline asli (jarang tapi mungkin di
 * kolom TEXT), baris lanjutannya digabung ke value field sebelumnya apa
 * adanya sebelum truncate diterapkan ke keseluruhan value gabungan.
 */
function previewTable(dbName, tableName) {
  const check = validateTableName(dbName, tableName);
  if (!check.valid) return { ok: false, errorMessage: check.reason };

  const result = runSQL(`SELECT * FROM \`${dbName}\`.\`${tableName}\` LIMIT ${PREVIEW_LIMIT};`, {
    vertical: true,
    maxBuffer: 10 * 1024 * 1024, // 10MB - jaga-jaga row lebar/kolom isi panjang sebelum sempat dipotong
  });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  if (!result.output.trim()) return { ok: true, rows: [] };

  const rowSeparator = /^\*+\s*\d+\.\s*row\s*\*+$/;
  const fieldLine = /^\s*([^:]+):\s(.*)$/;

  const lines = result.output.split('\n');
  const rows = [];
  let currentRow = null;

  for (const line of lines) {
    if (rowSeparator.test(line.trim())) {
      currentRow = [];
      rows.push(currentRow);
      continue;
    }
    if (!currentRow) continue;
    const match = line.match(fieldLine);
    if (match) {
      currentRow.push({ key: match[1].trim(), value: match[2] });
    } else if (currentRow.length > 0) {
      currentRow[currentRow.length - 1].value += `\n${line}`;
    }
  }

  const truncatedRows = rows.map((fields) =>
    fields.map(({ key, value }) => ({ key, value: truncateFieldValue(value) }))
  );

  return { ok: true, rows: truncatedRows };
}

/**
 * Cek apakah db_root_user (dari Configuration) punya "WITH GRANT OPTION".
 * Tanpa ini, `GRANT ALL PRIVILEGES ON db.* TO user` bakal ditolak MySQL -
 * tapi CREATE DATABASE / CREATE USER di statement SEBELUMNYA tetap sukses,
 * jadi hasilnya database + user "setengah jadi" (ada, tapi cuma privilege
 * USAGE) tanpa pesan error yang jelas soal grant. Preflight check ini
 * dipanggil SEBELUM createDatabase() mengeksekusi apapun, biar ketauan dari
 * awal kalau kredensial root-nya nggak cukup, bukan ketauan belakangan lewat
 * error Prisma P1010 yang membingungkan.
 */
function hasGrantOption() {
  const result = runSQL('SHOW GRANTS FOR CURRENT_USER();', { skipHeader: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  const grantOption = /GRANT OPTION/i.test(result.output) || /ALL PRIVILEGES ON \*\.\*/i.test(result.output);
  return { ok: true, hasOption: grantOption };
}

/**
 * Bikin database baru + user khusus (bukan root) dengan akses penuh HANYA ke
 * database itu. Password bisa custom (kalau user mau nentuin sendiri) atau
 * di-generate otomatis kalau dikosongin.
 */
function createDatabase(dbName, dbUser, customPassword) {
  if (!isValidName(dbName)) return { ok: false, errorMessage: 'Nama database tidak valid (hanya huruf/angka/underscore).' };
  if (!isValidName(dbUser)) return { ok: false, errorMessage: 'Nama user tidak valid (hanya huruf/angka/underscore).' };

  const grantCheck = hasGrantOption();
  if (!grantCheck.ok) {
    return { ok: false, errorMessage: `Gagal cek privilege db_root_user: ${grantCheck.errorMessage}` };
  }
  if (!grantCheck.hasOption) {
    return {
      ok: false,
      errorMessage:
        'db_root_user tidak punya "WITH GRANT OPTION", jadi database/user BELUM dibuat sama sekali (dibatalkan lebih awal supaya nggak setengah-jadi). ' +
        "Login sebagai root MySQL asli dan jalankan: GRANT ALL PRIVILEGES ON *.* TO 'db_root_user'@'localhost' WITH GRANT OPTION; (ganti db_root_user sesuai Configuration), lalu ulangi.",
    };
  }

  const password = customPassword && customPassword.trim() !== '' ? customPassword : generatePassword();
  const escapedPassword = escapeSqlString(password);

  const sql = `
    CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4;
    CREATE USER IF NOT EXISTS '${dbUser}'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY '${escapedPassword}';
    CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED WITH mysql_native_password BY '${escapedPassword}';
    GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'127.0.0.1';
    GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'localhost';
    FLUSH PRIVILEGES;
  `.replace(/\n\s*/g, ' ');

  const result = runSQL(sql);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  return {
    ok: true,
    dbName,
    dbUser,
    password,
    connectionUrl: `mysql://${dbUser}:${password}@127.0.0.1:3306/${dbName}`,
  };
}

/**
 * Reset password user database (dipakai kalau password lama lupa/nggak sempat
 * disimpan - MySQL nggak nyimpen plaintext jadi nggak bisa "dilihat lagi",
 * satu-satunya jalan adalah set ulang).
 */
function resetPassword(dbName, dbUser, customPassword) {
  if (!isValidName(dbName)) return { ok: false, errorMessage: 'Nama database tidak valid.' };
  if (!isValidName(dbUser)) return { ok: false, errorMessage: 'Nama user tidak valid.' };

  const password = customPassword && customPassword.trim() !== '' ? customPassword : generatePassword();
  const escapedPassword = escapeSqlString(password);

  const sql = `
    ALTER USER '${dbUser}'@'127.0.0.1' IDENTIFIED WITH mysql_native_password BY '${escapedPassword}';
    ALTER USER '${dbUser}'@'localhost' IDENTIFIED WITH mysql_native_password BY '${escapedPassword}';
    FLUSH PRIVILEGES;
  `.replace(/\n\s*/g, ' ');

  const result = runSQL(sql);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  return {
    ok: true,
    dbName,
    dbUser,
    password,
    connectionUrl: `mysql://${dbUser}:${password}@127.0.0.1:3306/${dbName}`,
  };
}

/**
 * Hapus database (dan optional user-nya). Dipakai hati-hati, nggak ada undo.
 */
function dropDatabase(dbName, dbUser) {
  if (!isValidName(dbName)) return { ok: false, errorMessage: 'Nama database tidak valid.' };

  let sql = `DROP DATABASE IF EXISTS \`${dbName}\`;`;
  if (dbUser && isValidName(dbUser)) {
    sql += ` DROP USER IF EXISTS '${dbUser}'@'127.0.0.1'; DROP USER IF EXISTS '${dbUser}'@'localhost'; FLUSH PRIVILEGES;`;
  }

  const result = runSQL(sql);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

/**
 * Tes koneksi ke MySQL pakai kredensial root yang ada di Configuration.
 */
function testConnection() {
  const result = runSQL('SELECT 1;');
  return result.ok
    ? { ok: true }
    : { ok: false, errorMessage: result.errorMessage || 'Gagal konek. Cek db_root_user/db_root_password di Configuration.' };
}

/**
 * Tes koneksi pakai kredensial SPESIFIK (dbUser/password milik satu database),
 * BUKAN kredensial root. Dipakai buat validasi pas Import Database - supaya
 * user tahu kredensial yang diketik itu beneran benar sebelum disimpan ke
 * registry, bukan asal simpan tanpa dicek.
 */
function testCredentials(dbName, dbUser, password) {
  if (!isValidName(dbName)) return { ok: false, errorMessage: 'Nama database tidak valid.' };
  if (!isValidName(dbUser)) return { ok: false, errorMessage: 'Nama user tidak valid.' };

  const env = { ...process.env };
  if (password) env.MYSQL_PWD = password;

  const result = shell.runArgs('mysql', ['-h', '127.0.0.1', '-P', '3306', '-u', dbUser, '-e', 'SELECT 1;', dbName], {
    silent: true,
    env,
  });
  if (!result.ok) {
    return { ok: false, errorMessage: interpretMysqlError(result.errorMessage) };
  }
  return { ok: true };
}

module.exports = {
  listDatabases,
  hasGrantOption,
  createDatabase,
  resetPassword,
  dropDatabase,
  testConnection,
  testCredentials,
  generatePassword,
  validateDatabaseName,
  validateTableName,
  listTables,
  describeTable,
  countRows,
  previewTable,
  mysqlCreds,
  isValidName,
  interpretMysqlError,
};