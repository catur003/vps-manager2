const express = require('express');
const security = require('../../security/security');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();

// Semua endpoint di file ini READ-ONLY (cek status, gak ada yang diubah) -
// gak ada guard confirmRequired karena gak ada action destruktif di sini.
function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

function handle(ACTION, req, res, fn) {
  if (!guard(ACTION, res)) return;
  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = fn();
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: `${ACTION.toUpperCase().replace(/\./g, '_')}_FAILED` });
  }
  const { ok, errorMessage, ...data } = result;
  res.json({ success: true, message: 'OK', data });
}

/**
 * Status firewall (ufw atau firewalld, mana yang terdeteksi aktif).
 */
router.get('/firewall', (req, res) => handle('security.checkFirewall', req, res, security.checkFirewall));

/**
 * Daftar port TCP listening di server (`ss -tlnp`), termasuk nama proses/pid
 * kalau kebaca.
 */
router.get('/ports', (req, res) => handle('security.listOpenPorts', req, res, security.listOpenPorts));

/**
 * Status fail2ban (terinstall & aktif atau tidak).
 */
router.get('/fail2ban', (req, res) => handle('security.checkFail2ban', req, res, security.checkFail2ban));

/**
 * Setting SSH krusial (PermitRootLogin, PasswordAuthentication, Port) dari
 * /etc/ssh/sshd_config.
 */
router.get('/ssh', (req, res) => handle('security.checkSshConfig', req, res, security.checkSshConfig));

module.exports = router;
