const shell = require('../utils/shell');
const config = require('../config/config');
const pm2 = require('../pm2/pm2');

/**
 * Ambil log PM2 sebuah app (reuse pm2.logs), format jadi array baris siap tampil.
 */
function getPm2Log(name, owner, lines = 50) {
  const result = pm2.logs(name, owner, lines);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true, lines: result.output.split('\n').filter(Boolean) };
}

/**
 * Ambil error log nginx per-domain (konvensi aaPanel: {nginx_log_dir}/{domain}.error.log).
 */
function getNginxErrorLog(domain, lines = 50) {
  const dir = config.loadConfig().nginx_log_dir;
  const logPath = `${dir}/${domain}.error.log`;
  const result = shell.run(`sudo tail -n ${lines} "${logPath}" 2>&1`, { silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  if (result.output.includes('No such file or directory')) {
    return { ok: false, errorMessage: `File log tidak ditemukan di ${logPath}. Cek "nginx_log_dir" di Configuration.` };
  }
  return { ok: true, lines: result.output.split('\n').filter(Boolean) };
}

/**
 * Kasih tanda visual di baris yang mengandung kata kunci error/warning,
 * biar gampang di-scan mata manusia tanpa baca semua baris satu-satu.
 */
function classifyLine(line) {
  const lower = line.toLowerCase();
  if (lower.includes('error') || lower.includes('fatal') || lower.includes('exception')) return 'error';
  if (lower.includes('warn')) return 'warn';
  return 'normal';
}

module.exports = { getPm2Log, getNginxErrorLog, classifyLine };
