const express = require('express');
const ai = require('../../ai/ai');
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

router.get('/models', async (req, res) => {
  const ACTION = 'ai.listModels';
  if (!guard(ACTION, res)) return;
  const result = await ai.listModels();
  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'AI_MODELS_FAILED' });
  res.json({ success: true, message: 'OK', data: result });
});

router.post('/chat', async (req, res) => {
  const ACTION = 'ai.chat';
  if (!guard(ACTION, res)) return;
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ success: false, message: 'messages wajib diisi (array).', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { messageCount: messages.length } });
  const result = await ai.runChat(messages);
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'AI_CHAT_FAILED' });
  res.json({ success: true, message: 'OK', data: result });
});

/**
 * Dipanggil setelah user klik "Izinkan" di modal permission - satu-satunya
 * jalan write-tool dari AI Assistant beneran DIEKSEKUSI (lihat ai.js
 * runChat(): tool 'write' SELALU stop & balikin pendingAction, gak pernah
 * auto-run).
 */
router.post('/confirm-action', async (req, res) => {
  const ACTION = 'ai.confirmAction';
  const policy = commandPolicy.getPolicy(ACTION);
  if (!policy) return res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });

  const { messages, toolCallId, toolName, args } = req.body || {};
  if (!Array.isArray(messages) || !toolCallId || !toolName) {
    return res.status(400).json({ success: false, message: 'messages, toolCallId, toolName wajib diisi.', code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { toolName, args } });
  const result = await ai.confirmAction(messages, toolCallId, toolName, args || {});
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) return res.status(400).json({ success: false, message: result.errorMessage, code: 'AI_CONFIRM_FAILED' });
  res.json({ success: true, message: 'OK', data: result });
});

module.exports = router;
