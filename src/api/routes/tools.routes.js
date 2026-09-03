const express = require('express');
const tools = require('../../tools/tools');
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
  const ACTION = 'tools.list';
  if (!guard(ACTION, res)) return;
  res.json({ success: true, message: 'OK', data: { tools: tools.detectTools() } });
});

router.post('/:key/install', (req, res) => {
  const ACTION = 'tools.install';
  if (!guard(ACTION, res)) return;
  const { key } = req.params;
  if (!tools.findTool(key)) {
    return res.status(400).json({ success: false, message: `Tool "${key}" tidak dikenal.`, code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { key } });
  const result = tools.installTool(key);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'TOOLS_INSTALL_FAILED' });
  }
  res.json({ success: true, message: `Tool "${key}" berhasil diinstall.` });
});

module.exports = router;
