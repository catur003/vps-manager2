const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const backup = require('../../backup/backup');
const database = require('../../database/database');
const registry = require('../../registry/registry');
const config = require('../../config/config');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const { validateName } = require('../../menu/helpers');

const router = express.Router();

// Nama file backup - whitelist ketat + WAJIB cocok sama salah satu entry
// hasil backup.listBackups() (bukan cuma lolos regex). Dua lapis ini penting
// karena filename dipakai buat path.join(backupDir(), filename) lalu
// disisipkan ke command shell (backup.js masih pakai shell.run() dengan
// string interpolation, bukan execFileSync) - regex doang gak cukup nutup
// path traversal/injection kalau suatu saat backupDir() pindah lokasi atau
// ada race condition; cross-check ke listing riil di disk pastiin filename
// yang diproses BENERAN salah satu file backup yang valid, titik.
const FILENAME_REGEX = /^[a-zA-Z0-9._-]+$/;

function isValidFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (!FILENAME_REGEX.test(filename)) return false;
  if (filename.includes('..')) return false;
  if (filename.startsWith('-') || filename.startsWith('.')) return false;
  return true;
}

function resolveBackupFile(filename, res) {
  if (!isValidFilename(filename)) {
    res.status(400).json({
      success: false,
      message: 'filename wajib diisi, hanya huruf/angka/titik/underscore/dash, tidak boleh mengandung ".." atau diawali "-"/".".',
      code: 'INVALID_INPUT',
    });
    return null;
  }
  const listResult = backup.listBackups();
  if (!listResult.backups.includes(filename)) {
    res.status(404).json({ success: false, message: `File backup "${filename}" tidak ditemukan.`, code: 'BACKUP_NOT_FOUND' });
    return null;
  }
  return filename;
}

// Upload SQL dari HP - disimpan di memory dulu (bukan langsung ke disk lewat
// multer diskStorage) karena nama file final WAJIB disanitasi ketat sebelum
// nyentuh filesystem (lihat safeUploadFilename), sama prinsip kayak validasi
// filename lain di file ini. Limit 300MB cukup buat dump SQL mentah (belum
// di-gzip) untuk kebanyakan database - samain kelasnya sama DB_MAX_BUFFER
// di backup.js.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } });

/**
 * Nama file upload dari HP TIDAK PERNAH dipercaya mentah-mentah (bisa berisi
 * path traversal, karakter shell, dll). Cuma ekstensi .sql/.sql.gz yang
 * diterima; sisanya di-strip ke charset aman lalu ditempel timestamp biar
 * gak collision & jelas ini hasil upload (bukan hasil backup.js sendiri).
 */
function safeUploadFilename(originalName) {
  const raw = typeof originalName === 'string' ? originalName : '';
  const isGz = /\.sql\.gz$/i.test(raw);
  const isSql = !isGz && /\.sql$/i.test(raw);
  if (!isGz && !isSql) return null;

  const ext = isGz ? '.sql.gz' : '.sql';
  const baseRaw = path.basename(raw, ext);
  const base = baseRaw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'upload';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `upload-${base}-${ts}${ext}`;
}

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * Resolusi project (path + deploy_user) dari nama registry - SATU-SATUNYA
 * sumber path/owner yang dipercaya, sama prinsip dengan git.routes.js.
 */
function resolveProject(name, res) {
  const nameCheck = validateName(name);
  if (nameCheck !== true) {
    res.status(400).json({ success: false, message: nameCheck, code: 'INVALID_INPUT' });
    return null;
  }
  const project = registry.findProject(name);
  if (!project) {
    res.status(404).json({ success: false, message: `Project "${name}" tidak ditemukan di registry.`, code: 'PROJECT_NOT_FOUND' });
    return null;
  }
  return { ...project, deploy_user: project.deploy_user || config.loadConfig().deploy_user };
}

function requireValidDbName(dbName, res, { mustExist = true } = {}) {
  if (mustExist) {
    const check = database.validateDatabaseName(dbName);
    if (!check.valid) {
      res.status(400).json({ success: false, message: check.reason, code: 'INVALID_INPUT' });
      return null;
    }
    return dbName;
  }
  if (!database.isValidName(dbName)) {
    res.status(400).json({ success: false, message: 'dbName tidak valid, hanya huruf/angka/underscore.', code: 'INVALID_INPUT' });
    return null;
  }
  return dbName;
}

/**
 * List semua file backup yang ada, terbaru dulu. Read-only.
 */
router.get('/', (req, res) => {
  const ACTION = 'backup.list';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = backup.listBackups();
  audit.recordEnd(auditId, { success: result.ok, message: 'OK', durationMs: Date.now() - startedAt });

  res.json({ success: true, message: 'OK', data: { backups: result.backups } });
});

/**
 * Backup project (folder) jadi .tar.gz. Path project di-resolve dari
 * registry (bukan body) - sama prinsip dengan git.routes.js.
 */
router.post('/projects/:name', (req, res) => {
  const ACTION = 'backup.project';
  if (!guard(ACTION, res)) return;
  const project = resolveProject(req.params.name, res);
  if (!project) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name } });
  const result = backup.backupProject(project.name, project.path);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || result.file || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'BACKUP_PROJECT_FAILED' });
  }
  res.status(201).json({ success: true, message: `Backup project "${project.name}" berhasil dibuat.`, data: { file: result.file } });
});

/**
 * Backup database jadi .sql.gz. dbName wajib exist (dicek lewat
 * database.validateDatabaseName - whitelist dari SHOW DATABASES, satu-satunya
 * cara aman karena nama database gak bisa di-parameterize kayak value SQL biasa).
 */
router.post('/databases/:dbName', (req, res) => {
  const ACTION = 'backup.database';
  if (!guard(ACTION, res)) return;
  const dbName = requireValidDbName(req.params.dbName, res);
  if (!dbName) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { dbName } });
  const result = backup.backupDatabase(dbName);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || result.file || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'BACKUP_DATABASE_FAILED' });
  }
  res.status(201).json({ success: true, message: `Backup database "${dbName}" berhasil dibuat.`, data: { file: result.file } });
});

/**
 * Restore project dari file .tar.gz ke folder project (path & deploy_user
 * di-resolve dari registry). Menimpa isi folder tujuan - DESTRUKTIF & gak ada
 * undo otomatis, WAJIB confirm:true.
 */
router.post('/projects/:name/restore', (req, res) => {
  const ACTION = 'backup.restoreProject';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const project = resolveProject(req.params.name, res);
  if (!project) return;

  const { filename, confirm } = req.body || {};
  const safeFilename = resolveBackupFile(filename, res);
  if (!safeFilename) return;

  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Aksi ini MENIMPA isi folder project "${project.name}" dengan isi backup "${safeFilename}". Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { name: project.name, filename: safeFilename } });
  const parentDir = path.dirname(project.path);
  const result = backup.restoreProject(safeFilename, parentDir, project.deploy_user);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'RESTORE_PROJECT_FAILED' });
  }
  res.json({ success: true, message: `Project "${project.name}" berhasil di-restore dari "${safeFilename}".` });
});

/**
 * Restore database dari file .sql.gz/.sql (lewat backup.restoreDatabase,
 * yang khusus buat file HASIL BACKUP tool ini sendiri, bukan sembarang SQL -
 * lihat /import-sql buat file SQL dari luar). Menimpa isi database tujuan -
 * DESTRUKTIF, WAJIB confirm:true.
 */
router.post('/databases/:dbName/restore', (req, res) => {
  const ACTION = 'backup.restoreDatabase';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const dbName = requireValidDbName(req.params.dbName, res);
  if (!dbName) return;

  const { filename, confirm } = req.body || {};
  const safeFilename = resolveBackupFile(filename, res);
  if (!safeFilename) return;

  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Aksi ini MENIMPA isi database "${dbName}" dengan isi backup "${safeFilename}". Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { dbName, filename: safeFilename } });
  const result = backup.restoreDatabase(safeFilename, dbName);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'RESTORE_DATABASE_FAILED' });
  }
  res.json({ success: true, message: `Database "${dbName}" berhasil di-restore dari "${safeFilename}".` });
});

/**
 * Hapus file backup. Permanen & gak ada undo, WAJIB confirm:true.
 */
router.delete('/:filename', (req, res) => {
  const ACTION = 'backup.delete';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }
  const safeFilename = resolveBackupFile(req.params.filename, res);
  if (!safeFilename) return;

  const { confirm } = req.body || {};
  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `File backup "${safeFilename}" akan dihapus PERMANEN. Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { filename: safeFilename } });
  const result = backup.deleteBackup(safeFilename);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'DELETE_BACKUP_FAILED' });
  }
  res.json({ success: true, message: `File backup "${safeFilename}" berhasil dihapus.` });
});

/**
 * Scan file .sql/.sql.gz "lepas" di folder umum VPS (backup_dir, /root, home
 * dir) - buat kasus file SQL yang dikirim manual (bukan hasil backup tool
 * ini), sebelum di-import. Read-only.
 */
router.get('/sql-files', (req, res) => {
  const ACTION = 'backup.scanSqlFiles';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = backup.scanSqlFiles();
  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });

  res.json({ success: true, message: 'OK', data: { files: result.found, scannedDirs: result.scannedDirs } });
});

/**
 * Import salah satu file hasil /sql-files ke database tujuan. `fullPath`
 * WAJIB persis sama dengan salah satu entry fullPath dari backup.scanSqlFiles()
 * SAAT INI (bukan sekadar format path yang "kelihatan" valid) - ini
 * satu-satunya cara aman ngasih klien pilih file SQL bebas dari luar backup_dir
 * tanpa buka celah baca/tulis file sembarang (path traversal): kita gak
 * percaya path dari body, kita percaya hasil scan folder whitelist kita sendiri.
 * Menimpa data di database tujuan - DESTRUKTIF, WAJIB confirm:true.
 */
router.post('/import-sql', (req, res) => {
  const ACTION = 'backup.importSql';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { fullPath, confirm } = req.body || {};
  const dbName = requireValidDbName((req.body || {}).dbName, res);
  if (!dbName) return;

  if (!fullPath || typeof fullPath !== 'string') {
    return res.status(400).json({ success: false, message: 'fullPath wajib diisi.', code: 'INVALID_INPUT' });
  }
  const scan = backup.scanSqlFiles();
  const match = scan.found.find((f) => f.fullPath === fullPath);
  if (!match) {
    return res.status(404).json({
      success: false,
      message: 'fullPath tidak ditemukan di hasil scan terbaru (GET /backup/sql-files). File harus ada di salah satu folder yang di-scan.',
      code: 'SQL_FILE_NOT_FOUND',
    });
  }

  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Aksi ini MENIMPA data di database "${dbName}" dengan isi file "${match.file}". Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { dbName, fullPath: match.fullPath } });
  const result = backup.importSqlFile(match.fullPath, dbName);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'IMPORT_SQL_FAILED' });
  }
  res.json({ success: true, message: `File "${match.file}" berhasil di-import ke database "${dbName}".` });
});

/**
 * Download 1 file backup ke device client (dipakai app buat "Unduh ke HP" -
 * save via share sheet / file manager). Read-only, filename tetap wajib
 * lolos resolveBackupFile() (whitelist + cross-check listBackups() nyata),
 * sama seperti restore/delete - satu-satunya beda cuma di sini kita STREAM
 * isinya, bukan proses isinya di server.
 */
router.get('/:filename/download', (req, res) => {
  const ACTION = 'backup.download';
  if (!guard(ACTION, res)) return;

  const safeFilename = resolveBackupFile(req.params.filename, res);
  if (!safeFilename) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { filename: safeFilename } });
  const fullPath = path.join(backup.backupDir(), safeFilename);

  res.download(fullPath, safeFilename, (err) => {
    // res.download() sendiri yang ngirim response (streaming) - callback ini
    // cuma buat audit log & nangkep error stream (mis. file kehapus di
    // tengah proses) TANPA nyoba kirim response lagi kalau header udah terkirim.
    audit.recordEnd(auditId, {
      success: !err,
      message: err ? err.message : 'OK',
      durationMs: Date.now() - startedAt,
    });
    if (err && !res.headersSent) {
      res.status(500).json({ success: false, message: 'Gagal mengirim file backup.', code: 'DOWNLOAD_FAILED' });
    }
  });
});

/**
 * Upload file .sql/.sql.gz dari HP ke folder backup_dir di server. Ini
 * CUMA nyimpen filenya - import ke database tetap lewat alur yang udah ada
 * (GET /backup/sql-files lalu POST /backup/import-sql), karena backupDir()
 * adalah salah satu folder yang di-scan scanSqlFiles(). Jadi setelah upload
 * sukses, file ini otomatis nongol di hasil scan berikutnya, gak perlu
 * endpoint import baru.
 */
router.post('/upload-sql', upload.single('file'), (req, res) => {
  const ACTION = 'backup.uploadSql';
  if (!guard(ACTION, res)) return;

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'File wajib diupload (field "file").', code: 'INVALID_INPUT' });
  }

  const safeName = safeUploadFilename(req.file.originalname);
  if (!safeName) {
    return res.status(400).json({
      success: false,
      message: 'File harus berekstensi .sql atau .sql.gz.',
      code: 'INVALID_INPUT',
    });
  }

  const ensureResult = backup.ensureBackupDir();
  if (!ensureResult.ok) {
    return res.status(500).json({ success: false, message: ensureResult.errorMessage, code: 'BACKUP_DIR_FAILED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { filename: safeName, sizeBytes: req.file.size } });
  const target = path.join(backup.backupDir(), safeName);

  try {
    fs.writeFileSync(target, req.file.buffer);
  } catch (err) {
    audit.recordEnd(auditId, { success: false, message: err.message, durationMs: Date.now() - startedAt });
    return res.status(500).json({ success: false, message: `Gagal simpan file upload: ${err.message}`, code: 'UPLOAD_WRITE_FAILED' });
  }

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.status(201).json({
    success: true,
    message: `File "${req.file.originalname}" berhasil diupload sebagai "${safeName}".`,
    data: { file: safeName, fullPath: target },
  });
});

module.exports = router;

/**
 * Security note (Fase 4.1 - FIXED): `backup.js` sekarang pakai
 * `shell.runArgs()`/execFileSync (argv terpisah) buat tar/mysqldump/mysql,
 * password mysql lewat env `MYSQL_PWD` (bukan diselipkan ke command string),
 * dan gzip/gunzip lewat Node `zlib` native (bukan spawn gzip/gunzip + shell
 * pipe `|`) - akar celah command injection & password-nongol-di-`ps aux`
 * sudah ditutup, sama pola dengan git.js Fase 3.1. Validasi di level route
 * (FILENAME_REGEX + cross-check listBackups(), database.validateDatabaseName(),
 * fullPath exact-match ke scanSqlFiles()) DIPERTAHANKAN sebagai
 * defense-in-depth, bukan lagi satu-satunya penutup celah.
 */
