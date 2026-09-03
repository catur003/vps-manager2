const express = require('express');
const postgres = require('../../database/postgres');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

router.get('/', (req, res) => {
  const ACTION = 'postgres.list';
  if (!guard(ACTION, res)) return;
  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = postgres.listDatabases();
  audit.recordEnd(auditId, { success: result.ok, message: result.error || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    if (result.notInstalled) {
      return res.json({ success: true, message: result.error, data: { databases: [], serverVersion: null, notInstalled: true } });
    }
    return res.status(500).json({ success: false, message: result.error, code: 'PG_LIST_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { databases: result.databases, serverVersion: postgres.getServerVersion() } });
});

router.post('/', (req, res) => {
  const ACTION = 'postgres.create';
  if (!guard(ACTION, res)) return;
  const { dbName, dbUser, password } = req.body || {};
  if (!dbName || !dbUser) return res.status(400).json({ success: false, message: 'dbName dan dbUser wajib diisi.', code: 'INVALID_INPUT' });

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { dbName, dbUser, password } });
  const result = postgres.createDatabase(dbName, dbUser, password);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'PG_CREATE_FAILED' });
  res.status(201).json({ success: true, message: 'Database PostgreSQL berhasil dibuat.', data: { dbName: result.dbName, dbUser: result.dbUser, password: result.password } });
});

router.post('/:dbName/reset-password', (req, res) => {
  const ACTION = 'postgres.resetPassword';
  if (!guard(ACTION, res)) return;
  const { dbUser, password } = req.body || {};
  if (!dbUser) return res.status(400).json({ success: false, message: 'dbUser wajib diisi.', code: 'INVALID_INPUT' });

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { dbUser, password } });
  const result = postgres.resetPassword(dbUser, password);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'PG_RESET_FAILED' });
  res.json({ success: true, message: 'Password berhasil direset.', data: { dbUser: result.dbUser, password: result.password } });
});

router.delete('/:dbName', (req, res) => {
  const ACTION = 'postgres.drop';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  const { dbName } = req.params;
  const { dbUser, confirm } = req.body || {};
  if (policy.confirmRequired && confirm !== true) {
    return res.status(400).json({ success: false, message: `Kirim ulang dengan { "confirm": true } untuk hapus database "${dbName}".`, code: 'CONFIRM_REQUIRED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { dbName, dbUser } });
  const result = postgres.dropDatabase(dbName, dbUser);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'PG_DROP_FAILED' });
  res.json({ success: true, message: `Database "${dbName}" berhasil dihapus.` });
});

router.post('/test', (req, res) => {
  const ACTION = 'postgres.test';
  if (!guard(ACTION, res)) return;
  const result = postgres.testConnection();
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'PG_TEST_FAILED' });
  res.json({ success: true, message: 'Koneksi PostgreSQL berhasil.' });
});

module.exports = router;
