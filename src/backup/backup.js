const path = require('path');
const os = require('os');
const fs = require('fs');
const zlib = require('zlib');
const shell = require('../utils/shell');
const config = require('../config/config');
const database = require('../database/database');

// mysqldump/mysql restore bisa makan waktu lama & output besar buat database
// gede - default Node (1MB buffer, gak ada timeout eksplisit di execFileSync)
// terlalu kecil/gak jelas. DB_MAX_BUFFER menampung dump sampai ~500MB (SQL
// text) di memory sebelum di-gzip; kalau nanti ada DB yang lebih besar dari
// itu, ini WAJIB direfactor jadi streaming (spawn + pipe manual), BUKAN cuma
// dinaikin angkanya - lihat catatan di backupDatabase().
const DB_MAX_BUFFER = 500 * 1024 * 1024;
const DB_TIMEOUT_MS = 30 * 60 * 1000; // 30 menit

function backupDir() {
  return config.loadConfig().backup_dir;
}

/**
 * Pastikan folder backup ada DAN dimiliki oleh user yang sedang menjalankan
 * tool ini (bukan root, bukan hardcode 'www'/'ubuntu'/dll). Dibaca dinamis
 * lewat os.userInfo() supaya tetap benar di VPS manapun / user operator manapun.
 *
 * Kenapa perlu: mkdir pakai sudo (jadi folder awalnya milik root), tapi
 * command lain yang nulis ke folder ini (mysqldump/gzip, tar) jalan sebagai
 * user biasa. Kalau ownership-nya nggak disamakan, command itu bakal kena
 * "Permission denied" pas nulis file.
 *
 * Semua argumen di sini (dir, currentUser) berasal dari config/OS, BUKAN dari
 * request API - tetap dipindah ke runArgs (execFileSync, argv terpisah)
 * demi konsistensi & defense-in-depth, bukan karena ada input eksternal langsung.
 */
function ensureBackupDir() {
  const dir = backupDir();

  const mkdirResult = shell.runArgs('sudo', ['mkdir', '-p', dir], { silent: true });
  if (!mkdirResult.ok) return { ok: false, errorMessage: mkdirResult.errorMessage };

  const currentUser = os.userInfo().username;

  const ownerCheck = shell.runArgs('stat', ['-c', '%U', dir], { silent: true });
  const currentOwner = ownerCheck.ok ? ownerCheck.output.trim() : '';

  if (currentOwner !== currentUser) {
    const chownResult = shell.runArgs('sudo', ['chown', '-R', `${currentUser}:${currentUser}`, dir], { silent: true });
    if (!chownResult.ok) {
      return {
        ok: false,
        errorMessage: `Gagal set kepemilikan folder backup ke user "${currentUser}": ${chownResult.errorMessage}`,
      };
    }
  }

  return { ok: true };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Backup folder project jadi .tar.gz, exclude node_modules & .next (folder besar
 * yang bisa dibangun ulang dari `npm install` + `npm run build`, jadi nggak perlu
 * ikut di-backup, biar hemat disk & lebih cepat).
 *
 * `name` dipakai buat nama file - dijamin aman sebelum sampai sini oleh
 * caller (route resolve project dari registry via validateName(), bukan raw
 * body), tapi tetap lewat runArgs (argv terpisah), BUKAN string command,
 * konsisten dengan seluruh file ini.
 */
function backupProject(name, projectPath) {
  const ensureResult = ensureBackupDir();
  if (!ensureResult.ok) return { ok: false, errorMessage: ensureResult.errorMessage };

  const filename = `project-${name}-${timestamp()}.tar.gz`;
  const target = path.join(backupDir(), filename);
  const parentDir = path.dirname(projectPath);
  const baseName = path.basename(projectPath);

  const result = shell.runArgs('sudo', [
    'tar', '-czf', target,
    '--exclude=node_modules', '--exclude=.next', '--exclude=.git',
    '-C', parentDir, baseName,
  ]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  return { ok: true, file: filename, path: target };
}

/**
 * Backup database jadi .sql.gz.
 *
 * FIXED (Fase 4.1): sebelumnya `mysqldump ... | gzip > target` dijalankan
 * sebagai satu string lewat shell (execSync) dan password mysql diselipkan
 * mentah ke command (`-p'${password}'`) - dua masalah sekaligus: (1) kalau
 * dbName/password pernah lolos ke sini tanpa validasi ketat, celah command
 * injection sama kayak yang di-fix di git.js Fase 3.1; (2) password nongol
 * di process list (`ps aux`) selama command jalan. Sekarang: `mysqldump`
 * dijalankan lewat execFileSync (argv terpisah, password via env MYSQL_PWD -
 * gak pernah jadi argv/command string sama sekali), outputnya (SQL text)
 * di-gzip pakai Node zlib native (BUKAN spawn `gzip` + shell pipe `|`) lalu
 * ditulis ke file langsung. Gak ada shell yang lihat command gabungan sama
 * sekali di seluruh proses ini.
 */
function backupDatabase(dbName) {
  const ensureResult = ensureBackupDir();
  if (!ensureResult.ok) return { ok: false, errorMessage: ensureResult.errorMessage };

  const { user, password } = database.mysqlCreds();
  const env = { ...process.env };
  if (password) env.MYSQL_PWD = password;

  const dumpResult = shell.runArgs('mysqldump', ['-h', '127.0.0.1', '-P', '3306', '-u', user, dbName], {
    silent: true,
    env,
    maxBuffer: DB_MAX_BUFFER,
    timeoutMs: DB_TIMEOUT_MS,
  });
  if (!dumpResult.ok) {
    return { ok: false, errorMessage: database.interpretMysqlError(dumpResult.errorMessage) };
  }

  const filename = `db-${dbName}-${timestamp()}.sql.gz`;
  const target = path.join(backupDir(), filename);
  try {
    const gzipped = zlib.gzipSync(Buffer.from(dumpResult.output, 'utf-8'));
    fs.writeFileSync(target, gzipped);
  } catch (err) {
    return { ok: false, errorMessage: `Gagal tulis file backup: ${err.message}` };
  }

  return { ok: true, file: filename, path: target };
}

/**
 * List semua file backup yang ada, diurut terbaru dulu.
 */
function listBackups() {
  const result = shell.runArgs('sudo', ['ls', '-t', backupDir()], { silent: true });
  if (!result.ok) return { ok: true, backups: [] }; // folder belum ada / kosong = belum ada backup
  const files = result.output.split('\n').filter(Boolean);
  return { ok: true, backups: files };
}

/**
 * Restore project dari file .tar.gz ke folder tujuan (folder tujuan akan ditimpa isinya).
 *
 * `filename` WAJIB sudah divalidasi oleh caller (whitelist + cross-check ke
 * listBackups() nyata - lihat backup.routes.js) sebelum dipanggil ke sini.
 * `deployUser` wajib diisi (dari registry project) - bukan di-hardcode -
 * karena tiap project bisa punya deploy_user beda. Tanpa ini, file hasil
 * extract (yang jalan pakai sudo tar) bakal kepemilikan root, dan proses
 * build/PM2 yang jalan sebagai deploy_user bakal gagal nulis ke folder itu.
 */
function restoreProject(filename, targetParentDir, deployUser) {
  const source = path.join(backupDir(), filename);
  const result = shell.runArgs('sudo', ['tar', '-xzf', source, '-C', targetParentDir]);
  if (!result.ok) return result;

  if (deployUser) {
    const chownResult = shell.runArgs('sudo', ['chown', '-R', `${deployUser}:${deployUser}`, targetParentDir]);
    if (!chownResult.ok) {
      return {
        ok: false,
        errorMessage: `Extract berhasil, tapi gagal set kepemilikan ke "${deployUser}": ${chownResult.errorMessage}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Restore database dari file .sql.gz (hasil backupDatabase() di atas).
 *
 * FIXED (Fase 4.1): sebelumnya `gunzip -c file | mysql ...` lewat shell +
 * password mentah di command string. Sekarang: file di-gunzip pakai Node
 * zlib native (baca langsung dari disk, bukan spawn `gunzip`), lalu SQL
 * hasil gunzip dikirim ke `mysql` lewat stdin (`options.input` di
 * execFileSync) - bukan file temp, bukan shell pipe. Password tetap lewat
 * env MYSQL_PWD.
 */
function restoreDatabase(filename, dbName) {
  const source = path.join(backupDir(), filename);
  let sql;
  try {
    sql = zlib.gunzipSync(fs.readFileSync(source));
  } catch (err) {
    return { ok: false, errorMessage: `Gagal baca/extract file backup: ${err.message}` };
  }

  const { user, password } = database.mysqlCreds();
  const env = { ...process.env };
  if (password) env.MYSQL_PWD = password;

  const result = shell.runArgs('mysql', ['-h', '127.0.0.1', '-P', '3306', '-u', user, dbName], {
    silent: true,
    env,
    input: sql,
    maxBuffer: DB_MAX_BUFFER,
    timeoutMs: DB_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, errorMessage: database.interpretMysqlError(result.errorMessage) };
  return result;
}

/**
 * `filename` WAJIB sudah divalidasi caller (lihat restoreProject() note).
 */
function deleteBackup(filename) {
  return shell.runArgs('sudo', ['rm', path.join(backupDir(), filename)]);
}

/**
 * Hapus backup yang lebih tua dari retention_days (default 7 hari), biar disk
 * nggak penuh sama backup lama yang menumpuk. `days` dipaksa jadi integer
 * non-negatif sebelum disisipkan ke argv (config internal, bukan input
 * request langsung, tapi tetap dijaga formatnya).
 */
function cleanOldBackups() {
  const cfg = config.loadConfig();
  const rawDays = cfg.backup_retention_days || 7;
  const days = Math.max(0, Math.floor(Number(rawDays)) || 7);
  const result = shell.runArgs('sudo', ['find', backupDir(), '-type', 'f', '-mtime', `+${days}`, '-print', '-delete'], { silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  const deleted = result.output.split('\n').filter(Boolean);
  return { ok: true, deleted };
}

/**
 * Scan file .sql dan .sql.gz di beberapa folder umum VPS:
 *   1. Folder backup tool (backup_dir dari config)
 *   2. /root
 *   3. Home dir user yang lagi jalanin tool (os.homedir())
 *
 * Path di-deduplikasi (kalau overlap, mis. tool dijalanin sebagai root),
 * dan setiap folder dicek eksistensinya dulu sebelum di-scan.
 *
 * Return: array of { file, dir, fullPath } diurutkan alphabetically per folder.
 */
function scanSqlFiles() {
  const scannedDirs = [];
  const seen = new Set();

  // Kumpulin semua folder kandidat tanpa duplikat
  const candidates = [backupDir(), '/root', os.homedir()];
  for (const dir of candidates) {
    if (!dir) continue;
    const normalized = path.resolve(dir);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    scannedDirs.push(normalized);
  }

  const found = [];
  for (const dir of scannedDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      const sqlFiles = entries
        .filter((f) => /\.sql(\.gz)?$/i.test(f))
        .sort()
        .map((file) => ({ file, dir, fullPath: path.join(dir, file) }));
      found.push(...sqlFiles);
    } catch (err) {
      // Folder nggak bisa dibaca (permission denied, dll) — skip saja
    }
  }

  return { found, scannedDirs };
}

/**
 * Import file SQL ke database tujuan. Support dua format:
 *   - .sql      → isi file dikirim langsung ke stdin `mysql`
 *   - .sql.gz   → di-gunzip (Node zlib) dulu, hasilnya dikirim ke stdin `mysql`
 *
 * `sqlFilePath` WAJIB sudah divalidasi caller (cross-check exact ke hasil
 * scanSqlFiles() saat ini - lihat backup.routes.js /import-sql) - fungsi ini
 * TIDAK validasi ulang bahwa path ini "aman", cuma percaya path yang dikirim.
 * `dbName` juga harus sudah divalidasi exist sebelum memanggil fungsi ini.
 */
function importSqlFile(sqlFilePath, dbName) {
  let sql;
  try {
    const raw = fs.readFileSync(sqlFilePath);
    sql = /\.sql\.gz$/i.test(sqlFilePath) ? zlib.gunzipSync(raw) : raw;
  } catch (err) {
    return { ok: false, errorMessage: `Gagal baca/extract file SQL: ${err.message}` };
  }

  const { user, password } = database.mysqlCreds();
  const env = { ...process.env };
  if (password) env.MYSQL_PWD = password;

  const result = shell.runArgs('mysql', ['-h', '127.0.0.1', '-P', '3306', '-u', user, dbName], {
    silent: true,
    env,
    input: sql,
    maxBuffer: DB_MAX_BUFFER,
    timeoutMs: DB_TIMEOUT_MS,
  });
  if (!result.ok) return { ok: false, errorMessage: database.interpretMysqlError(result.errorMessage) };
  return result;
}

module.exports = {
  backupProject,
  backupDatabase,
  listBackups,
  restoreProject,
  restoreDatabase,
  deleteBackup,
  cleanOldBackups,
  backupDir,
  scanSqlFiles,
  importSqlFile,
  ensureBackupDir,
};
