const express = require('express');
const registry = require('../../registry/registry');
const nginx = require('../../nginx/nginx');
const ssl = require('../../ssl/ssl');
const audit = require('../audit');
const commandPolicy = require('../commandPolicy');
const { validateDomainRequired } = require('../../menu/helpers');

const router = express.Router();

function guard(action, res) {
  if (!commandPolicy.isExposed(action)) {
    res.status(403).json({ success: false, message: 'Action belum diizinkan.', code: 'ACTION_NOT_ALLOWED' });
    return false;
  }
  return true;
}

/**
 * Endpoint ini gabungin 3 sumber data yang SEBELUMNYA cuma bisa dicek satu-satu
 * lewat 3 menu terpisah (Site Nginx / SSL / Project) - lihat diskusi soal domain
 * yang "hilang-muncul lagi" gara-gara ketiganya gak saling sinkron. Gak ada
 * logic baru di sini, murni komposisi dari fungsi yang sudah ada:
 * registry.findByDomain/isProjectAlive, nginx.listSites, ssl.checkCertExists/
 * checkExpiry - biar satu response langsung kasih gambaran utuh.
 */
function buildDomainStatus(domain, nginxSites, projects) {
  const nginxSite = nginxSites.find((s) => s.domain === domain) || null;
  const project = projects.find((p) => p.domain === domain) || null;

  let projectStatus = null;
  if (project) {
    const liveness = registry.isProjectAlive(project);
    projectStatus = { name: project.name, alive: liveness.alive, port: project.port };
  }

  const sslExists = ssl.checkCertExists(domain);
  let sslInfo = { exists: sslExists, daysLeft: null, expiringSoon: false };
  if (sslExists) {
    const expiry = ssl.checkExpiry(domain);
    if (expiry.ok) {
      sslInfo.daysLeft = expiry.daysLeft;
      sslInfo.expiringSoon = expiry.daysLeft <= 14;
    }
  }

  return {
    domain,
    nginx: nginxSite ? { exists: true, file: nginxSite.file, target: nginxSite.target } : { exists: false },
    project: projectStatus,
    ssl: sslInfo,
  };
}

/**
 * GET /domains - list semua domain yang dikenal sistem dari MANAPUN
 * (file nginx ATAU tercatat di registry project - union, bukan intersection,
 * biar domain yang "nyangkut" di salah satu sisi tetap kelihatan bukannya
 * ke-hide begitu aja).
 */
router.get('/', (req, res) => {
  const ACTION = 'domains.list';
  if (!guard(ACTION, res)) return;

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: {} });

  const sitesResult = nginx.listSites();
  const nginxSites = sitesResult.ok ? sitesResult.sites : [];
  const projects = registry.listProjects().filter((p) => p.domain);

  const domainSet = new Set([...nginxSites.map((s) => s.domain), ...projects.map((p) => p.domain)]);
  const domains = [...domainSet].sort().map((domain) => buildDomainStatus(domain, nginxSites, projects));

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.json({ success: true, message: 'OK', data: domains });
});

/**
 * GET /domains/:domain - status satu domain spesifik. Dipakai buat live-check
 * pas user lagi ngetik domain (create site / daftar SSL) SEBELUM submit, dan
 * buat konfirmasi hapus site yang butuh tau dampaknya dulu.
 */
router.get('/:domain', (req, res) => {
  const ACTION = 'domains.status';
  if (!guard(ACTION, res)) return;

  const { domain } = req.params;
  const domainCheck = validateDomainRequired(domain);
  if (domainCheck !== true) {
    return res.status(400).json({ success: false, message: domainCheck, code: 'INVALID_INPUT' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { domain } });

  const sitesResult = nginx.listSites();
  const nginxSites = sitesResult.ok ? sitesResult.sites : [];
  const projects = registry.listProjects().filter((p) => p.domain);
  const status = buildDomainStatus(domain, nginxSites, projects);

  audit.recordEnd(auditId, { success: true, message: 'OK', durationMs: Date.now() - startedAt });
  res.json({ success: true, message: 'OK', data: status });
});

module.exports = router;
