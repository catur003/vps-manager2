const express = require('express');
const scanner = require('../../scanner/scanner');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');

const router = express.Router();

// Semua endpoint di file ini READ-ONLY (baca kondisi server & bandingin ke
// registry, gak ada yang diubah).
function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * Daftar semua app PM2 dari semua user relevan, dikelompokkan per owner.
 */
router.get('/pm2', (req, res) => {
  const ACTION = 'scanner.pm2Apps';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = scanner.scanPm2Apps();
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'SCAN_PM2_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { apps: result.apps, grouped: result.grouped, warnings: result.warnings } });
});

/**
 * Cek port: port yang beneran kebuka di server vs yang tercatat di registry,
 * plus port "asing" yang gak dikenal (orphan).
 */
router.get('/ports', (req, res) => {
  const ACTION = 'scanner.ports';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = scanner.scanPorts();
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'SCAN_PORTS_FAILED' });
  }
  res.json({ success: true, message: 'OK', data: { projectChecks: result.projectChecks, orphanPorts: result.orphanPorts } });
});

/**
 * Health-check HTTP ke tiap project yang punya port (request 1x ke
 * 127.0.0.1:port, lihat status respons). Jalanin scanPorts() dulu di dalam
 * buat tau port mana yang emang kebuka (skip request ke port yang jelas mati).
 */
router.get('/api-health', async (req, res) => {
  const ACTION = 'scanner.apiHealth';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });

  const portResult = scanner.scanPorts();
  if (!portResult.ok) {
    audit.recordEnd(auditId, { success: false, message: portResult.errorMessage, durationMs: Date.now() - startedAt });
    return res.status(400).json({ success: false, message: portResult.errorMessage, code: 'SCAN_PORTS_FAILED' });
  }
  const apiResults = await scanner.scanApiHealth(portResult.projectChecks);
  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });

  res.json({ success: true, message: 'OK', data: { results: apiResults } });
});

/**
 * Full scan (4 tahap sekaligus): PM2 apps + port check + API health +
 * cocokkan ke registry (folder exist, PM2 found, port match, domain match)
 * + PM2 app yang gak ketemu di registry sama sekali (orphan).
 */
router.get('/full', async (req, res) => {
  const ACTION = 'scanner.full';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });
  const result = await scanner.scanAll();
  audit.recordEnd(auditId, { success: result.ok, message: result.errorMessage || 'OK', durationMs: Date.now() - startedAt });

  if (!result.ok) {
    return res.status(400).json({ success: false, message: result.errorMessage, code: 'SCAN_FULL_FAILED' });
  }
  const { ok, ...data } = result;
  res.json({ success: true, message: 'OK', data });
});

module.exports = router;
