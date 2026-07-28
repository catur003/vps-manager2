const express = require('express');
const shell = require('../../utils/shell');
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

/**
 * PERINGATAN - beda prinsip dari SEMUA route lain di codebase ini:
 * endpoint ini sengaja BEBAS, command dieksekusi mentah lewat shell
 * (shell.run -> execSync), BUKAN scoped/whitelist/argv-only seperti
 * backup.js, git.js, dll. Ini dibuat atas permintaan eksplisit ("terminal
 * dari HP") - kalau API key bocor, ini setara akses shell penuh sebagai
 * user yang jalanin vps-api (`catur`). Jaga API key ekstra ketat.
 */
router.post('/exec', (req, res) => {
  const ACTION = 'system.exec';
  if (!guard(ACTION, res)) return;

  const { command } = req.body || {};
  if (!command || typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ success: false, message: 'Command wajib diisi.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { command } });
  const result = shell.run(command, { timeoutMs: 30000, maxBuffer: 5 * 1024 * 1024 });
  audit.recordEnd(auditId, {
    success: result.ok,
    message: result.ok ? 'OK' : result.errorMessage,
    durationMs: Date.now() - startedAt,
  });

  // success:true di sini artinya REQUEST-nya berhasil diproses - command-nya
  // sendiri boleh aja exit non-zero, itu dikirim balik lewat exitOk/output,
  // bukan dianggap error HTTP (biar output/stderr-nya tetep keliatan di app).
  res.json({
    success: true,
    message: result.ok ? 'OK' : (result.errorMessage || 'Command exit dengan error.'),
    data: { output: result.output || '', exitOk: result.ok, errorMessage: result.ok ? undefined : result.errorMessage },
  });
});

module.exports = router;
