const express = require('express');
const sshkeys = require('../../ssh/sshkeys');
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
  const ACTION = 'sshkeys.list';
  if (!guard(ACTION, res)) return;
  const result = sshkeys.listKeys();
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'SSHKEYS_LIST_FAILED' });
  res.json({ success: true, message: 'OK', data: result });
});

router.post('/', (req, res) => {
  const ACTION = 'sshkeys.add';
  if (!guard(ACTION, res)) return;
  const { publicKey } = req.body || {};
  if (!publicKey || typeof publicKey !== 'string') {
    return res.status(400).json({ success: false, message: 'publicKey wajib diisi.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = sshkeys.addKey(publicKey);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'SSHKEYS_ADD_FAILED' });
  res.status(201).json({ success: true, message: 'SSH key berhasil ditambahkan.' });
});

router.delete('/:fingerprint', (req, res) => {
  const ACTION = 'sshkeys.remove';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
  if (policy.confirmRequired && req.body?.confirm !== true) {
    return res.status(400).json({ success: false, message: 'Kirim ulang dengan { "confirm": true } untuk hapus SSH key ini.', code: 'CONFIRM_REQUIRED' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { fingerprint: req.params.fingerprint } });
  const result = sshkeys.removeKey(req.params.fingerprint);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'SSHKEYS_REMOVE_FAILED' });
  res.json({ success: true, message: 'SSH key berhasil dihapus.' });
});

module.exports = router;
