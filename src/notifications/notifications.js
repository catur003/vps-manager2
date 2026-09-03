const fs = require('fs');
const audit = require('../api/audit');
const monitor = require('../monitor/monitor');
const security = require('../security/security');
const registry = require('../registry/registry');
const ssl = require('../ssl/ssl');

/**
 * Feed notifikasi GABUNGAN dari sumber yang BENERAN ada di server ini -
 * TIDAK ADA angka/event yang di-fake kayak di mockup referensi ("Disk usage
 * critical 92%", dst - itu di sini dihitung LANGSUNG dari monitor.getStatus()
 * real, bukan hardcode). 4 sumber:
 * 1. Audit log (data/audit.log) - histori aksi yang beneran dieksekusi lewat
 *    panel ini (deploy, restart, hapus, dst).
 * 2. Threshold disk/RAM SAAT INI (snapshot, bukan historis - server ini gak
 *    nyimpen time-series metric).
 * 3. Domain yang SSL-nya mau expire (<=14 hari, sama ambang batas dengan
 *    badge "expiringSoon" di halaman Domains).
 * 4. Ban fail2ban yang LAGI AKTIF (currently banned, dari jail detail).
 */

const ACTION_LABELS = {
  'pm2.restart': { title: 'PM2 Process Restarted', severity: 'info' },
  'pm2.stop': { title: 'PM2 Process Stopped', severity: 'warning' },
  'pm2.start': { title: 'PM2 Process Started', severity: 'success' },
  'pm2.delete': { title: 'PM2 App Deleted', severity: 'warning' },
  'docker.run': { title: 'Docker Container Started', severity: 'success' },
  'docker.remove': { title: 'Docker Container Removed', severity: 'warning' },
  'docker.restart': { title: 'Docker Container Restarted', severity: 'info' },
  'dockerCompose.deploy': { title: 'Docker Deploy Started', severity: 'info' },
  'project.redeploy': { title: 'Redeploy Triggered', severity: 'info' },
  'webhook_redeploy': { title: 'Auto-Deploy via Webhook', severity: 'info' },
  'filemanager.delete': { title: 'File/Folder Deleted', severity: 'warning' },
  'sshkeys.add': { title: 'SSH Key Added', severity: 'info' },
  'sshkeys.remove': { title: 'SSH Key Removed', severity: 'warning' },
  'tools.install': { title: 'Tool Installed', severity: 'success' },
  'database.drop': { title: 'Database Dropped', severity: 'critical' },
  'ssl.issue': { title: 'SSL Certificate Issued', severity: 'success' },
  'backup.project': { title: 'Backup Completed', severity: 'success' },
  'backup.database': { title: 'Backup Completed', severity: 'success' },
};

function getAuditEvents(limit) {
  if (!fs.existsSync(audit.AUDIT_LOG_PATH)) return [];
  const lines = fs.readFileSync(audit.AUDIT_LOG_PATH, 'utf8').split('\n').filter(Boolean);
  const starts = new Map();
  const events = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.event === 'start') starts.set(entry.auditId, entry);
    else if (entry.event === 'end') {
      const start = starts.get(entry.auditId);
      const action = start?.action || 'unknown';
      const meta = ACTION_LABELS[action];
      if (!meta) continue; // action gak dikenal (mis. read-only kayak pm2.list) - jangan diikutin, biar feed gak penuh noise
      events.push({
        id: `audit-${entry.auditId}`,
        type: action,
        severity: entry.success ? meta.severity : 'critical',
        title: meta.title,
        message: entry.message && entry.message !== 'OK' ? entry.message.slice(0, 140) : `Aksi "${action}" ${entry.success ? 'berhasil' : 'gagal'}.`,
        at: entry.at,
      });
    }
  }
  return events.slice(-limit).reverse();
}

function getThresholdAlerts() {
  const status = monitor.getStatus();
  const alerts = [];
  const diskAgg = status.disk?.aggregate || status.disk;
  if (diskAgg && diskAgg.percent >= 90) {
    alerts.push({
      id: 'threshold-disk', type: 'threshold', severity: 'critical', title: 'Disk usage critical',
      message: `Disk usage ${diskAgg.percent}% (${diskAgg.used} / ${diskAgg.total})`, at: new Date().toISOString(),
    });
  } else if (diskAgg && diskAgg.percent >= 75) {
    alerts.push({
      id: 'threshold-disk', type: 'threshold', severity: 'warning', title: 'Disk usage tinggi',
      message: `Disk usage ${diskAgg.percent}% (${diskAgg.used} / ${diskAgg.total})`, at: new Date().toISOString(),
    });
  }
  if (status.ram && status.ram.percent >= 90) {
    alerts.push({
      id: 'threshold-ram', type: 'threshold', severity: 'critical', title: 'High memory usage',
      message: `RAM usage ${status.ram.percent}% (${status.ram.usedMB}MB / ${status.ram.totalMB}MB)`, at: new Date().toISOString(),
    });
  } else if (status.ram && status.ram.percent >= 75) {
    alerts.push({
      id: 'threshold-ram', type: 'threshold', severity: 'warning', title: 'Memory usage tinggi',
      message: `RAM usage ${status.ram.percent}% (${status.ram.usedMB}MB / ${status.ram.totalMB}MB)`, at: new Date().toISOString(),
    });
  }
  return alerts;
}

function getSslExpiryAlerts() {
  const alerts = [];
  const projects = registry.listProjects().filter((p) => p.domain);
  for (const project of projects) {
    if (!ssl.checkCertExists(project.domain)) continue;
    const expiry = ssl.checkExpiry(project.domain);
    if (expiry.ok && expiry.daysLeft <= 14) {
      alerts.push({
        id: `ssl-${project.domain}`, type: 'ssl', severity: expiry.daysLeft <= 3 ? 'critical' : 'warning',
        title: 'SSL Certificate Expiring Soon',
        message: `Sertifikat untuk "${project.domain}" akan expire dalam ${expiry.daysLeft} hari.`,
        at: new Date().toISOString(),
      });
    }
  }
  return alerts;
}

function getFail2banAlerts() {
  const result = security.checkFail2ban();
  if (!result.ok || !result.jails) return [];
  const alerts = [];
  for (const jail of result.jails) {
    for (const ip of jail.bannedIps) {
      alerts.push({
        id: `ban-${jail.jail}-${ip}`, type: 'fail2ban', severity: 'warning',
        title: 'IP Banned (Fail2ban)',
        message: `${ip} di-ban oleh jail "${jail.jail}".`, at: new Date().toISOString(),
      });
    }
  }
  return alerts;
}

function getNotifications(limit = 50) {
  const merged = [
    ...getThresholdAlerts(),
    ...getSslExpiryAlerts(),
    ...getFail2banAlerts(),
    ...getAuditEvents(limit),
  ];
  merged.sort((a, b) => (a.at < b.at ? 1 : -1));
  return merged.slice(0, limit);
}

module.exports = { getNotifications };
