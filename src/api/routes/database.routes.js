const express = require('express');
const database = require('../../database/database');
const dbRegistry = require('../../registry/dbRegistry');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();
const ACTION = 'database.create';
const SAFE_NAME = /^[a-zA-Z0-9_]+$/;

function validateBody(body) {
  if (!body.dbName || !SAFE_NAME.test(body.dbName)) {
    return 'dbName wajib diisi, hanya huruf/angka/underscore.';
  }
  if (!body.dbUser || !SAFE_NAME.test(body.dbUser)) {
    return 'dbUser wajib diisi, hanya huruf/angka/underscore.';
  }
  return true;
}

/**
 * Sengaja SYNC (bukan job/worker async kayak /deploy atau /ssl/issue) -
 * `createDatabase()` cuma beberapa statement SQL, normalnya selesai dalam
 * hitungan detik (ada timeout 30 detik di runSQL buat jaga-jaga, lihat
 * database.js). Beda jauh dari deploy (bisa menitan: git clone, npm install,
 * build) atau SSL (round-trip network ke Let's Encrypt) yang emang butuh
 * background job biar API gak ke-block lama.
 */
router.post('/', (req, res) => {
  if (!commandPolicy.isExposed(ACTION)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const validation = validateBody(req.body || {});
  if (validation !== true) {
    return res.status(400).json({ success: false, message: validation, code: 'INVALID_INPUT' });
  }

  const { dbName, dbUser, password } = req.body;
  const startedAt = Date.now();
  // password custom (kalau ada) di-redact di audit log lewat audit.js redact()
  // sendiri (regex-nya match kata "password") - TIDAK perlu ditangani manual di sini.
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { dbName, dbUser, password } });

  const result = database.createDatabase(dbName, dbUser, password);

  if (!result.ok) {
    audit.recordEnd(auditId, { success: false, message: result.errorMessage, durationMs: Date.now() - startedAt });
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'CREATE_DATABASE_FAILED' });
  }

  // Daftarin ke dbRegistry biar kekliatan di menu CLI juga (satu sumber data),
  // BUKAN cuma balik lewat response API doang.
  try {
    dbRegistry.upsertEntry({ dbName, dbUser, password: result.password, connectionUrl: result.connectionUrl });
  } catch (err) {
    // Database SUDAH beneran kebuat di MySQL di titik ini - kalau upsert ke
    // registry gagal, jangan pura-pura seolah create-nya gagal total (bisa
    // bikin user coba lagi dan nabrak "database sudah ada"). Tetap laporkan
    // sukses, tapi kasih catetan jelas.
    audit.recordEnd(auditId, { success: true, message: `Database dibuat, tapi gagal sync ke dbRegistry: ${err.message}`, durationMs: Date.now() - startedAt });
    return res.json({
      success: true,
      message: `Database "${dbName}" berhasil dibuat, TAPI gagal disinkron ke dbRegistry (cek manual lewat CLI: menu Database → Import). Error: ${err.message}`,
      data: result,
    });
  }

  audit.recordEnd(auditId, { success: true, message: `Database "${dbName}" berhasil dibuat.`, durationMs: Date.now() - startedAt });

  res.status(201).json({
    success: true,
    message: `Database "${dbName}" dan user "${dbUser}" berhasil dibuat.`,
    data: result,
  });
});

/**
 * List semua database (kecuali database sistem bawaan MySQL). Read-only,
 * jadi gak perlu confirm.
 */
router.get('/', (req, res) => {
  const ACTION_LIST = 'database.list';
  if (!commandPolicy.isExposed(ACTION_LIST)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_LIST, ip: req.ip, params: {} });

  const result = database.listDatabases();
  if (!result.ok) {
    audit.recordEnd(auditId, { success: false, message: result.error, durationMs: Date.now() - startedAt });
    return res.status(500).json({ success: false, message: result.error, code: 'LIST_DATABASES_FAILED' });
  }

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.json({ success: true, message: 'OK', data: { databases: result.databases } });
});

/**
 * List semua tabel di satu database. Nama db divalidasi format dulu
 * (defense-in-depth), lalu database.listTables() sendiri yang whitelist-cek
 * ke SHOW DATABASES sebelum dipakai di SQL manapun.
 */
router.get('/:dbName/tables', (req, res) => {
  const ACTION_TABLES = 'database.listTables';
  if (!commandPolicy.isExposed(ACTION_TABLES)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { dbName } = req.params;
  if (!SAFE_NAME.test(dbName)) {
    return res.status(400).json({ success: false, message: 'Nama database tidak valid.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_TABLES, ip: req.ip, params: { dbName } });

  const result = database.listTables(dbName);
  if (!result.ok) {
    audit.recordEnd(auditId, { success: false, message: result.errorMessage, durationMs: Date.now() - startedAt });
    const notFound = /tidak ditemukan/i.test(result.errorMessage || '');
    return res.status(notFound ? 404 : 400).json({
      success: false,
      message: result.errorMessage,
      code: notFound ? 'DATABASE_NOT_FOUND' : 'LIST_TABLES_FAILED',
    });
  }

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.json({ success: true, message: 'OK', data: { dbName, tables: result.tables } });
});

/**
 * Struktur kolom sebuah tabel (setara DESCRIBE di menu CLI).
 */
router.get('/:dbName/tables/:tableName/describe', (req, res) => {
  const ACTION_DESCRIBE = 'database.describeTable';
  if (!commandPolicy.isExposed(ACTION_DESCRIBE)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { dbName, tableName } = req.params;
  if (!SAFE_NAME.test(dbName) || !SAFE_NAME.test(tableName)) {
    return res.status(400).json({ success: false, message: 'Nama database/tabel tidak valid.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_DESCRIBE, ip: req.ip, params: { dbName, tableName } });

  const result = database.describeTable(dbName, tableName);
  if (!result.ok) {
    audit.recordEnd(auditId, { success: false, message: result.errorMessage, durationMs: Date.now() - startedAt });
    const notFound = /tidak ditemukan/i.test(result.errorMessage || '');
    return res.status(notFound ? 404 : 400).json({
      success: false,
      message: result.errorMessage,
      code: notFound ? 'TABLE_NOT_FOUND' : 'DESCRIBE_TABLE_FAILED',
    });
  }

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.json({ success: true, message: 'OK', data: { dbName, tableName, columns: result.columns } });
});

/**
 * Jumlah total baris di tabel.
 */
router.get('/:dbName/tables/:tableName/count', (req, res) => {
  const ACTION_COUNT = 'database.countRows';
  if (!commandPolicy.isExposed(ACTION_COUNT)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { dbName, tableName } = req.params;
  if (!SAFE_NAME.test(dbName) || !SAFE_NAME.test(tableName)) {
    return res.status(400).json({ success: false, message: 'Nama database/tabel tidak valid.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_COUNT, ip: req.ip, params: { dbName, tableName } });

  const result = database.countRows(dbName, tableName);
  if (!result.ok) {
    audit.recordEnd(auditId, { success: false, message: result.errorMessage, durationMs: Date.now() - startedAt });
    const notFound = /tidak ditemukan/i.test(result.errorMessage || '');
    return res.status(notFound ? 404 : 400).json({
      success: false,
      message: result.errorMessage,
      code: notFound ? 'TABLE_NOT_FOUND' : 'COUNT_ROWS_FAILED',
    });
  }

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.json({ success: true, message: 'OK', data: { dbName, tableName, total: result.total } });
});

/**
 * Preview isi tabel (LIMIT 10 baris, format vertical, field kepanjangan
 * dipotong) - persis behavior "Lihat Isi" di menu CLI. Read-only.
 */
router.get('/:dbName/tables/:tableName/preview', (req, res) => {
  const ACTION_PREVIEW = 'database.previewTable';
  if (!commandPolicy.isExposed(ACTION_PREVIEW)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { dbName, tableName } = req.params;
  if (!SAFE_NAME.test(dbName) || !SAFE_NAME.test(tableName)) {
    return res.status(400).json({ success: false, message: 'Nama database/tabel tidak valid.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_PREVIEW, ip: req.ip, params: { dbName, tableName } });

  const result = database.previewTable(dbName, tableName);
  if (!result.ok) {
    audit.recordEnd(auditId, { success: false, message: result.errorMessage, durationMs: Date.now() - startedAt });
    const notFound = /tidak ditemukan/i.test(result.errorMessage || '');
    return res.status(notFound ? 404 : 400).json({
      success: false,
      message: result.errorMessage,
      code: notFound ? 'TABLE_NOT_FOUND' : 'PREVIEW_TABLE_FAILED',
    });
  }

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.json({ success: true, message: 'OK', data: { dbName, tableName, rows: result.rows } });
});

/**
 * Reset password user database. dbUser wajib dikirim (registry dicek dulu
 * buat auto-fill kalau ada, tapi API tetap butuh eksplisit karena gak ada
 * "prompt" kayak CLI). Password baru bisa custom lewat body.password, kalau
 * kosong di-generate otomatis (sama seperti create).
 */
router.post('/:dbName/reset-password', (req, res) => {
  const ACTION_RESET = 'database.resetPassword';
  if (!commandPolicy.isExposed(ACTION_RESET)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { dbName } = req.params;
  const { dbUser, password } = req.body || {};
  if (!SAFE_NAME.test(dbName)) {
    return res.status(400).json({ success: false, message: 'Nama database tidak valid.', code: 'INVALID_INPUT' });
  }
  if (!dbUser || !SAFE_NAME.test(dbUser)) {
    return res.status(400).json({ success: false, message: 'dbUser wajib diisi, hanya huruf/angka/underscore.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_RESET, ip: req.ip, params: { dbName, dbUser, password } });

  const result = database.resetPassword(dbName, dbUser, password);
  if (!result.ok) {
    audit.recordEnd(auditId, { success: false, message: result.errorMessage, durationMs: Date.now() - startedAt });
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'RESET_PASSWORD_FAILED' });
  }

  // Sync ke dbRegistry biar connectionUrl gak basi (samain sama fix "Bug B" di
  // menu CLI) - existing entry di-merge dulu (bukan ditimpa polos) supaya
  // field lain kayak usedByProject gak ikut hilang.
  try {
    const existingEntry = dbRegistry.findByName(dbName) || {};
    dbRegistry.upsertEntry({ ...existingEntry, dbName: result.dbName, dbUser: result.dbUser, password: result.password, connectionUrl: result.connectionUrl });
  } catch (err) {
    audit.recordEnd(auditId, { success: true, message: `Password direset, tapi gagal sync ke dbRegistry: ${err.message}`, durationMs: Date.now() - startedAt });
    return res.json({
      success: true,
      message: `Password user "${dbUser}" berhasil direset, TAPI gagal disinkron ke dbRegistry. Error: ${err.message}`,
      data: result,
    });
  }

  audit.recordEnd(auditId, { success: true, message: `Password user "${dbUser}" berhasil direset.`, durationMs: Date.now() - startedAt });
  res.json({ success: true, message: `Password user "${dbUser}" berhasil direset.`, data: result });
});

/**
 * Hapus database (dan optional user-nya). Destruktif & gak ada undo, jadi
 * DIWAJIBKAN confirm:true di body (commandPolicy.getPolicy(...).confirmRequired) -
 * ini pengecekan pertama di codebase yang beneran menegakkan confirmRequired,
 * sebelumnya field ini di commandPolicy cuma metadata yang gak pernah dibaca
 * di manapun.
 */
router.delete('/:dbName', (req, res) => {
  const ACTION_DROP = 'database.drop';
  const policy = commandPolicy.getPolicy(ACTION_DROP);
  if (!policy) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { dbName } = req.params;
  const { dbUser, confirm } = req.body || {};
  if (!SAFE_NAME.test(dbName)) {
    return res.status(400).json({ success: false, message: 'Nama database tidak valid.', code: 'INVALID_INPUT' });
  }
  if (dbUser && !SAFE_NAME.test(dbUser)) {
    return res.status(400).json({ success: false, message: 'dbUser tidak valid, hanya huruf/angka/underscore.', code: 'INVALID_INPUT' });
  }
  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({
      success: false,
      message: `Aksi ini menghapus database "${dbName}" secara PERMANEN. Kirim ulang dengan { "confirm": true } di body kalau yakin.`,
      code: 'CONFIRM_REQUIRED',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_DROP, ip: req.ip, params: { dbName, dbUser } });

  const result = database.dropDatabase(dbName, dbUser);
  if (!result.ok) {
    audit.recordEnd(auditId, { success: false, message: result.errorMessage, durationMs: Date.now() - startedAt });
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'DROP_DATABASE_FAILED' });
  }

  try {
    dbRegistry.removeEntry(dbName);
  } catch (err) {
    audit.recordEnd(auditId, { success: true, message: `Database dihapus, tapi gagal bersihin dbRegistry: ${err.message}`, durationMs: Date.now() - startedAt });
    return res.json({
      success: true,
      message: `Database "${dbName}" berhasil dihapus, TAPI gagal dibersihkan dari dbRegistry. Error: ${err.message}`,
    });
  }

  audit.recordEnd(auditId, { success: true, message: `Database "${dbName}" berhasil dihapus.`, durationMs: Date.now() - startedAt });
  res.json({ success: true, message: `Database "${dbName}" berhasil dihapus.` });
});

/**
 * PATCH /database/:dbName/link - set/lepas field usedByProject di dbRegistry
 * secara manual. Ditambah buat nutup bug: database yang dibuat lewat
 * POST /database/ (API/app) TIDAK PERNAH ke-link ke project manapun secara
 * otomatis (beda dari menu CLI) - efeknya toggle "Drop Database" pas Hapus
 * Project diam-diam gak ngefek karena deleteProject.js gak nemu database
 * "terkait" apapun. Deploy baru sudah auto-link sendiri (lihat deployNew.js),
 * endpoint ini buat database YANG SUDAH TERLANJUR dibuat sebelum fix ini ada.
 *
 * Body: { projectName: string | null } - null/'' buat unlink manual.
 */
router.patch('/:dbName/link', (req, res) => {
  const ACTION_LINK = 'database.link';
  if (!commandPolicy.isExposed(ACTION_LINK)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { dbName } = req.params;
  if (!SAFE_NAME.test(dbName)) {
    return res.status(400).json({ success: false, message: 'Nama database tidak valid.', code: 'INVALID_INPUT' });
  }

  const { projectName } = req.body || {};
  if (projectName !== null && projectName !== undefined && typeof projectName !== 'string') {
    return res.status(400).json({ success: false, message: 'projectName harus teks atau null.', code: 'INVALID_INPUT' });
  }

  const entry = dbRegistry.findByName(dbName);
  if (!entry) {
    return res.status(404).json({ success: false, message: `Database "${dbName}" tidak ditemukan di registry.`, code: 'NOT_FOUND' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_LINK, ip: req.ip, params: { dbName, projectName: projectName || null } });

  const normalized = projectName && projectName.trim() ? projectName.trim() : null;
  dbRegistry.upsertEntry({ ...entry, usedByProject: normalized });

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.json({
    success: true,
    message: normalized
      ? `Database "${dbName}" ditandai dipakai oleh project "${normalized}".`
      : `Database "${dbName}" dilepas keterkaitannya dari project manapun.`,
  });
});

/**
 * Tes koneksi MySQL pakai kredensial root dari Configuration. Read-only,
 * gak ngubah state - cuma `SELECT 1;`.
 */
router.get('/test-connection', (req, res) => {
  const ACTION_TEST = 'database.testConnection';
  if (!commandPolicy.isExposed(ACTION_TEST)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_TEST, ip: req.ip, params: {} });

  const result = database.testConnection();
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'TEST_CONNECTION_FAILED' });
  }
  res.json({ success: true, message: 'Koneksi ke MySQL berhasil.', data: {} });
});

/**
 * Tes koneksi pakai kredensial SPESIFIK (dbUser/password satu database),
 * BUKAN root - dipakai buat validasi sebelum simpan ke dbRegistry (mis. alur
 * "Import Database" di CLI). Read-only.
 */
router.post('/test-credentials', (req, res) => {
  const ACTION_TEST_CREDS = 'database.testCredentials';
  if (!commandPolicy.isExposed(ACTION_TEST_CREDS)) {
    return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  }

  const { dbName, dbUser, password } = req.body || {};
  if (!dbName || !SAFE_NAME.test(dbName)) {
    return res.status(400).json({ success: false, message: 'dbName wajib diisi, hanya huruf/angka/underscore.', code: 'INVALID_INPUT' });
  }
  if (!dbUser || !SAFE_NAME.test(dbUser)) {
    return res.status(400).json({ success: false, message: 'dbUser wajib diisi, hanya huruf/angka/underscore.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION_TEST_CREDS, ip: req.ip, params: { dbName, dbUser, password } });

  const result = database.testCredentials(dbName, dbUser, password);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'TEST_CREDENTIALS_FAILED' });
  }
  res.json({ success: true, message: 'Kredensial valid, koneksi berhasil.', data: {} });
});

module.exports = router;
module.exports.validateBody = validateBody;
