const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fm = require('../../filemanager/filemanager');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();
const uploadTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-manager-upload-'));
const upload = multer({ dest: uploadTmpDir, limits: { fileSize: 200 * 1024 * 1024 } });

function cleanupUpload(req) {
  const tempPath = req.file?.path;
  if (!tempPath) return;
  try { fs.unlinkSync(tempPath); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

function requirePath(req, res) {
  const p = req.query.path || req.body?.path;
  if (!p || typeof p !== 'string' || !p.startsWith('/')) {
    res.status(400).json({ success: false, message: 'Parameter "path" wajib diisi dan harus absolute (mulai dari /).', code: 'INVALID_INPUT' });
    return null;
  }
  return path.normalize(p);
}

router.get('/list', (req, res) => {
  const ACTION = 'filemanager.list';
  if (!guard(ACTION, res)) return;
  const p = requirePath(req, res);
  if (!p) return;
  const result = fm.listDir(p);
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_LIST_FAILED' });
  res.json({ success: true, message: 'OK', data: result });
});

router.get('/read', (req, res) => {
  const ACTION = 'filemanager.read';
  if (!guard(ACTION, res)) return;
  const p = requirePath(req, res);
  if (!p) return;
  const result = fm.readFile(p);
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_READ_FAILED' });
  res.json({ success: true, message: 'OK', data: result });
});

router.post('/write', (req, res) => {
  const ACTION = 'filemanager.write';
  if (!guard(ACTION, res)) return;
  const p = requirePath(req, res);
  if (!p) return;
  const { content } = req.body || {};
  if (typeof content !== 'string') {
    return res.status(400).json({ success: false, message: 'content wajib diisi (string).', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { path: p } });
  const result = fm.writeFile(p, content);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_WRITE_FAILED' });
  res.json({ success: true, message: 'File berhasil disimpan.' });
});

router.post('/mkdir', (req, res) => {
  const ACTION = 'filemanager.mkdir';
  if (!guard(ACTION, res)) return;
  const p = requirePath(req, res);
  if (!p) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { path: p } });
  const result = fm.mkdir(p);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_MKDIR_FAILED' });
  res.status(201).json({ success: true, message: 'Folder berhasil dibuat.' });
});

router.post('/chown', (req, res) => {
  const ACTION = 'filemanager.chown';
  if (!guard(ACTION, res)) return;
  const p = requirePath(req, res);
  if (!p) return;
  const { owner } = req.body || {};
  if (!owner || typeof owner !== 'string') {
    return res.status(400).json({ success: false, message: 'owner wajib diisi (mis. "catur" atau "catur:catur").', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { path: p, owner } });
  const result = fm.chown(p, owner);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_CHOWN_FAILED' });
  res.json({ success: true, message: `Owner "${p}" diubah jadi "${owner}".` });
});

router.get('/users', (req, res) => {
  const ACTION = 'filemanager.listUsers';
  if (!guard(ACTION, res)) return;
  const result = fm.listSystemUsers();
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_LIST_USERS_FAILED' });
  res.json({ success: true, message: 'OK', data: { users: result.users } });
});

router.post('/chmod', (req, res) => {
  const ACTION = 'filemanager.chmod';
  if (!guard(ACTION, res)) return;
  const p = requirePath(req, res);
  if (!p) return;
  const { mode } = req.body || {};
  if (!mode || typeof mode !== 'string') {
    return res.status(400).json({ success: false, message: 'mode wajib diisi (mis. "755").', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { path: p, mode } });
  const result = fm.chmod(p, mode);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_CHMOD_FAILED' });
  res.json({ success: true, message: `Permission "${p}" diubah jadi "${mode}".` });
});

router.post('/rename', (req, res) => {
  const ACTION = 'filemanager.rename';
  if (!guard(ACTION, res)) return;
  const { oldPath, newPath } = req.body || {};
  if (!oldPath || !newPath || !oldPath.startsWith('/') || !newPath.startsWith('/')) {
    return res.status(400).json({ success: false, message: 'oldPath dan newPath wajib diisi, absolute.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { oldPath, newPath } });
  const result = fm.rename(oldPath, newPath);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_RENAME_FAILED' });
  res.json({ success: true, message: 'Berhasil di-rename/dipindah.' });
});

router.delete('/', (req, res) => {
  const ACTION = 'filemanager.delete';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  const p = requirePath(req, res);
  if (!p) return;
  if (policy.confirmRequired && req.body?.confirm !== true) {
    return res.status(400).json({ success: false, message: `"${p}" akan dihapus PERMANEN (termasuk isi folder kalau itu folder). Kirim ulang dengan { "confirm": true }.`, code: 'CONFIRM_REQUIRED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { path: p } });
  const result = fm.deleteEntry(p);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_DELETE_FAILED' });
  res.json({ success: true, message: `"${p}" berhasil dihapus.` });
});

router.post('/upload', upload.single('file'), (req, res) => {
  const ACTION = 'filemanager.upload';
  if (!guard(ACTION, res)) { cleanupUpload(req); return; }
  const destDir = req.body?.path;
  if (!destDir || !destDir.startsWith('/')) {
    cleanupUpload(req);
    return res.status(400).json({ success: false, message: 'path (folder tujuan) wajib diisi.', code: 'INVALID_INPUT' });
  }
  if (!req.file) return res.status(400).json({ success: false, message: 'File wajib disertakan.', code: 'INVALID_INPUT' });

  const filename = path.basename(req.file.originalname || '');
  if (!filename || filename === '.' || filename === '..') {
    cleanupUpload(req);
    return res.status(400).json({ success: false, message: 'Nama file tidak valid.', code: 'INVALID_INPUT' });
  }
  const destPath = path.posix.join(path.posix.normalize(destDir), filename);
  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { destPath, size: req.file.size } });
  const result = fm.uploadFile(destPath, req.file.path);
  cleanupUpload(req);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_UPLOAD_FAILED' });
  res.status(201).json({ success: true, message: `File berhasil diupload ke "${destPath}".` });
});

router.get('/download', (req, res) => {
  const ACTION = 'filemanager.download';
  if (!guard(ACTION, res)) return;
  const p = requirePath(req, res);
  if (!p) return;

  const result = fm.downloadFile(p);
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'FM_DOWNLOAD_FAILED' });

  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(p).replace(/"/g, '')}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(result.size));
  let stderr = '';
  result.child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString().slice(0, 8192 - stderr.length); });
  result.child.once('error', (err) => { if (!res.headersSent) res.status(500).json({ success: false, message: err.message, code: 'FM_DOWNLOAD_FAILED' }); else res.destroy(err); });
  result.child.once('close', (code) => { if (code !== 0 && !res.destroyed) res.destroy(new Error(stderr.trim() || `sudo cat keluar dengan kode ${code}`)); });
  res.once('close', () => { if (!res.writableEnded && result.child.exitCode === null) result.child.kill('SIGTERM'); });
  result.stream.pipe(res);
});

module.exports = router;
