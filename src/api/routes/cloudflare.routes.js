const express = require('express');
const cloudflare = require('../../cloudflare/cloudflare');
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

router.post('/purge-cache', async (req, res) => {
  const ACTION = 'cloudflare.purgeCache';
  if (!guard(ACTION, res)) return;
  const { domain } = req.body || {};
  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ success: false, message: 'domain wajib diisi.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { domain } });
  const result = await cloudflare.purgeCache(domain);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'CF_PURGE_FAILED' });
  res.json({ success: true, message: `Cache Cloudflare untuk "${domain}" berhasil di-purge.` });
});

router.post('/under-attack', async (req, res) => {
  const ACTION = 'cloudflare.underAttack';
  if (!guard(ACTION, res)) return;
  const { domain, enabled } = req.body || {};
  if (!domain || typeof domain !== 'string' || typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, message: 'domain (string) dan enabled (boolean) wajib diisi.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { domain, enabled } });
  const result = await cloudflare.setUnderAttackMode(domain, enabled);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'CF_UNDER_ATTACK_FAILED' });
  res.json({ success: true, message: `Under Attack Mode untuk "${domain}" ${enabled ? 'diaktifkan' : 'dinonaktifkan'}.` });
});

module.exports = router;
