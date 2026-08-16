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
  // nginx server_name sekarang bisa berisi lebih dari satu nama (domain +
  // alias, dipisah spasi - lihat nginx.createReverseProxySite/upgradeToSSL),
  // jadi dicek per-token, bukan exact match ke seluruh string server_name.
  const nginxSite =
    nginxSites.find((s) => s.domain === domain || (s.domain || '').split(/\s+/).includes(domain)) || null;
  const project = projects.find((p) => p.domain === domain || (p.aliases || []).includes(domain)) || null;
  const isAlias = !!project && project.domain !== domain;

  let projectStatus = null;
  if (project) {
    const liveness = registry.isProjectAlive(project);
    projectStatus = { name: project.name, alive: liveness.alive, port: project.port };
  }

  // Sertifikat alias (mis. "www.domain") DISIMPAN di folder domain UTAMA
  // (lihat --cert-name di ssl.issueCertificate), bukan folder bernama
  // alias itu sendiri - jadi certPaths harus dicek pakai project.domain,
  // bukan `domain` mentah, kalau ini alias. Tanpa ini, alias yang sudah
  // sungguhan ke-cover SAN sertifikat tetap keliatan "belum SSL" di sini.
  const certLookupDomain = project ? project.domain : domain;
  const sslExists = ssl.checkCertExists(certLookupDomain);
  let sslInfo = { exists: sslExists, daysLeft: null, expiringSoon: false };
  if (sslExists) {
    const expiry = ssl.checkExpiry(certLookupDomain);
    if (expiry.ok) {
      sslInfo.daysLeft = expiry.daysLeft;
      sslInfo.expiringSoon = expiry.daysLeft <= 14;
    }
  }

  return {
    domain,
    isAlias,
    aliasOf: isAlias ? project.domain : null,
    aliases: project && !isAlias ? project.aliases || [] : [],
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

  // server_name nginx bisa berisi beberapa nama sekaligus (domain + alias)
  // dipisah spasi, jadi dipecah dulu biar tiap nama muncul sebagai entri
  // domain sendiri (bukan satu entri gabungan "domain www.domain").
  const nginxNames = nginxSites.flatMap((s) => (s.domain || '').split(/\s+/).filter(Boolean));
  const projectNames = projects.flatMap((p) => [p.domain, ...(p.aliases || [])]);

  const domainSet = new Set([...nginxNames, ...projectNames]);
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

/**
 * POST /domains/:domain/aliases - tambah domain alias (mis. "www.zenin.my.id")
 * ke project yang domain UTAMA-nya `:domain` ("zenin.my.id"). Ini akar
 * perbaikan issue "www gabisa karena gada project": alias TIDAK perlu
 * didaftarkan sebagai project terpisah (beda port/folder) - cukup nempel
 * ke project yang sudah ada, lalu satu sertifikat SSL yang sama meng-cover
 * domain utama + semua alias-nya (lihat ssl.issueCertificate).
 *
 * Efek samping: langsung regenerate config nginx (server_name gabungan).
 * Kalau site ini SUDAH HTTPS aktif, sertifikat LAMA belum cover alias baru -
 * response ngingetin buat re-issue SSL (POST /ssl/issue) supaya alias ikut
 * dapet HTTPS beneran, bukan cuma "diterima" nginx-nya doang.
 */
router.post('/:domain/aliases', (req, res) => {
  const ACTION = 'domains.addAlias';
  if (!guard(ACTION, res)) return;

  const { domain } = req.params;
  const { alias } = req.body || {};

  const aliasCheck = validateDomainRequired(alias);
  if (aliasCheck !== true) {
    return res.status(400).json({ success: false, message: aliasCheck, code: 'INVALID_INPUT' });
  }

  const project = registry.findByDomain(domain);
  if (!project) {
    return res.status(404).json({
      success: false,
      message: `Domain "${domain}" belum terdaftar di project manapun.`,
      code: 'DOMAIN_NOT_REGISTERED',
    });
  }
  if (project.domain !== domain) {
    return res.status(400).json({
      success: false,
      message: `"${domain}" adalah alias, bukan domain utama project "${project.name}". Tambahkan alias lewat domain utamanya: "${project.domain}".`,
      code: 'NOT_PRIMARY_DOMAIN',
    });
  }
  if (project.domain === alias || (project.aliases || []).includes(alias)) {
    return res.status(400).json({ success: false, message: `"${alias}" sudah terdaftar di project ini.`, code: 'ALREADY_EXISTS' });
  }
  const clash = registry.findByDomain(alias);
  if (clash) {
    return res.status(409).json({
      success: false,
      message: `"${alias}" sudah dipakai project lain ("${clash.name}").`,
      code: 'DOMAIN_CONFLICT',
    });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { domain, alias } });

  const newAliases = [...(project.aliases || []), alias];
  const updated = registry.updateProject(project.name, { aliases: newAliases });

  const hasSsl = ssl.checkCertExists(domain);
  const genResult = hasSsl
    ? nginx.upgradeToSSL({ domain, aliases: newAliases, port: project.port, ...ssl.certPaths(domain) })
    : nginx.createReverseProxySite({ domain, aliases: newAliases, port: project.port });

  audit.recordEnd(auditId, {
    success: genResult.ok,
    message: genResult.ok ? 'OK' : genResult.errorMessage,
    durationMs: Date.now() - startedAt,
  });

  if (!genResult.ok) {
    return res.status(500).json({
      success: false,
      message: `Alias tersimpan di registry tapi gagal update config nginx: ${genResult.errorMessage}`,
      code: 'NGINX_UPDATE_FAILED',
      data: updated,
    });
  }

  res.json({
    success: true,
    message: hasSsl
      ? `Alias "${alias}" ditambahkan & nginx diupdate. Sertifikat SSL yang aktif SEKARANG BELUM cover alias ini - jalankan "Terbitkan SSL" lagi untuk "${domain}" biar "${alias}" ikut HTTPS.`
      : `Alias "${alias}" ditambahkan & nginx diupdate.`,
    data: updated,
  });
});

/**
 * DELETE /domains/:domain/aliases/:alias - lepas alias dari project.
 * Sertifikat SSL lama TIDAK otomatis di-reissue ulang tanpa alias ini
 * (certbot cuma nambah SAN lewat --expand, bukan ngurangin) - alias yang
 * dilepas cuma berhenti dilayani nginx-nya, sertifikatnya sendiri baru
 * "bersih" dari nama itu pas renew berikutnya atau re-issue manual.
 */
router.delete('/:domain/aliases/:alias', (req, res) => {
  const ACTION = 'domains.removeAlias';
  if (!guard(ACTION, res)) return;

  const { domain, alias } = req.params;
  const project = registry.findByDomain(domain);
  if (!project || project.domain !== domain) {
    return res.status(404).json({ success: false, message: `Domain utama "${domain}" tidak ditemukan.`, code: 'DOMAIN_NOT_REGISTERED' });
  }
  if (!(project.aliases || []).includes(alias)) {
    return res.status(404).json({ success: false, message: `"${alias}" bukan alias project ini.`, code: 'NOT_FOUND' });
  }

  const startedAt = Date.now();
  const auditId = audit.recordStart({ action: ACTION, ip: req.ip, params: { domain, alias } });

  const newAliases = (project.aliases || []).filter((a) => a !== alias);
  const updated = registry.updateProject(project.name, { aliases: newAliases });

  const hasSsl = ssl.checkCertExists(domain);
  const genResult = hasSsl
    ? nginx.upgradeToSSL({ domain, aliases: newAliases, port: project.port, ...ssl.certPaths(domain) })
    : nginx.createReverseProxySite({ domain, aliases: newAliases, port: project.port });

  audit.recordEnd(auditId, {
    success: genResult.ok,
    message: genResult.ok ? 'OK' : genResult.errorMessage,
    durationMs: Date.now() - startedAt,
  });

  if (!genResult.ok) {
    return res.status(500).json({
      success: false,
      message: `Alias dihapus dari registry tapi gagal update nginx: ${genResult.errorMessage}`,
      code: 'NGINX_UPDATE_FAILED',
      data: updated,
    });
  }

  res.json({
    success: true,
    message: `Alias "${alias}" dihapus dari nginx. (Sertifikat SSL lama masih menyebut domain ini sampai renew/re-issue berikutnya - bukan masalah keamanan, cuma nganggur.)`,
    data: updated,
  });
});

module.exports = router;
