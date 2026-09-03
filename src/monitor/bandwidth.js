const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../utils/safeFile');
const shell = require('../utils/shell');

const HISTORY_PATH = path.join(__dirname, '..', '..', 'data', 'bandwidth-history.json');
const SAMPLE_INTERVAL_MS = 60 * 60 * 1000; // sample tiap 1 jam
const HISTORY_RETENTION_DAYS = 30;
// Interface publik utama - EXCLUDE loopback/docker0/veth*/br-* (internal only,
// bakal nge-double-count trafik yang sama dgn enp0s6 kalau ikut dijumlah).
const EXCLUDED_INTERFACE_PREFIXES = ['lo', 'docker', 'veth', 'br-', 'tun', 'virbr'];

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Parse /proc/net/dev, jumlahin RX/TX byte SEMUA interface publik (bukan
 * cuma 1 nama hardcode - nama interface bisa beda-beda antar VPS provider,
 * mis. enp0s6 di OCI vs eth0 di provider lain).
 */
function getInterfaceStats() {
  const content = fs.readFileSync('/proc/net/dev', 'utf8');
  const lines = content.split('\n').slice(2).filter(Boolean);
  let rxBytes = 0;
  let txBytes = 0;
  const perInterface = [];
  for (const line of lines) {
    const [ifaceRaw, rest] = line.split(':');
    const iface = ifaceRaw.trim();
    if (!rest) continue;
    if (EXCLUDED_INTERFACE_PREFIXES.some((p) => iface.startsWith(p))) continue;
    const fields = rest.trim().split(/\s+/).map(Number);
    const rx = fields[0] || 0;
    const tx = fields[8] || 0;
    rxBytes += rx;
    txBytes += tx;
    perInterface.push({ interface: iface, rxBytes: rx, txBytes: tx });
  }
  return { rxBytes, txBytes, perInterface };
}

/**
 * Network I/O per container Docker - `docker stats --no-stream` udah ngasih
 * ini langsung (kumulatif sejak container start, BUKAN sejak host boot),
 * jadi gak butuh sampling/delta kayak /proc/net/dev punya host.
 */
function getDockerContainerStats() {
  const result = shell.run('sudo docker stats --no-stream --format "{{.Name}}|{{.NetIO}}"', { silent: true });
  if (!result.ok || !result.output) return [];
  return result.output.split('\n').filter(Boolean).map((line) => {
    const [name, netIo] = line.split('|');
    const [rxRaw, txRaw] = (netIo || '').split(' / ');
    return { name, rx: (rxRaw || '').trim(), tx: (txRaw || '').trim() };
  });
}

/**
 * Storage R2 real (bukan estimasi) - pakai rclone yang sudah dikonfigurasi
 * (lihat /home/ubuntu/.config/rclone/rclone.conf, dipasang buat fitur
 * backup offsite). Kalau rclone/config belum ada, balikin null (bukan
 * error) - widget quota di dashboard cukup nyembunyiin section ini.
 */
function getR2Usage(bucket = 'anime') {
  // rclone.conf milik user "ubuntu" (600) - proses panel jalan sebagai
  // "catur", jadi WAJIB lewat runAsUser (bash -c sebagai ubuntu, satu-satunya
  // rule sudoers yang izinin catur "jadi" ubuntu), bukan shell.run() polos.
  const result = shell.runAsUser('ubuntu', `rclone size r2:${bucket} --json --config ~/.config/rclone/rclone.conf 2>/dev/null`, { silent: true });
  if (!result.ok || !result.output) return null;
  try {
    const parsed = JSON.parse(result.output);
    return { bytes: parsed.bytes || 0, bytesLabel: formatBytes(parsed.bytes || 0), objectCount: parsed.count || 0 };
  } catch (err) {
    return null;
  }
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch (err) {
    return { lastSample: null, dailyTotals: {} };
  }
}

function saveHistory(history) {
  atomicWriteJSON(HISTORY_PATH, history, 0o600);
}

/**
 * Sampler berkala - dipanggil dari server.js via setInterval (sama pola
 * scheduleSslAutoRenew/alerting). Hitung DELTA byte sejak sample terakhir
 * (counter /proc/net/dev itu kumulatif sejak boot, reset ke 0 tiap reboot -
 * delta negatif dianggap reboot terjadi, sample ini di-skip dari akumulasi
 * biar gak salah baca angka minus sebagai "trafik negatif").
 */
function sampleAndRecord() {
  const history = loadHistory();
  const now = Date.now();
  const stats = getInterfaceStats();
  const today = new Date().toISOString().slice(0, 10);

  if (history.lastSample && history.lastSample.rxBytes <= stats.rxBytes && history.lastSample.txBytes <= stats.txBytes) {
    const deltaRx = stats.rxBytes - history.lastSample.rxBytes;
    const deltaTx = stats.txBytes - history.lastSample.txBytes;
    if (!history.dailyTotals[today]) history.dailyTotals[today] = { rxBytes: 0, txBytes: 0 };
    history.dailyTotals[today].rxBytes += deltaRx;
    history.dailyTotals[today].txBytes += deltaTx;
  }

  history.lastSample = { at: now, rxBytes: stats.rxBytes, txBytes: stats.txBytes };

  // Buang entry lebih lama dari retensi
  const cutoff = new Date(now - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  Object.keys(history.dailyTotals).forEach((day) => { if (day < cutoff) delete history.dailyTotals[day]; });

  saveHistory(history);
}

function scheduleBandwidthSampler() {
  setInterval(sampleAndRecord, SAMPLE_INTERVAL_MS);
  sampleAndRecord(); // sample sekali langsung pas startup
}

function getSummary() {
  const history = loadHistory();
  const stats = getInterfaceStats();
  const days = Object.keys(history.dailyTotals).sort();
  const last30 = days.slice(-30).map((day) => ({
    date: day,
    rxBytes: history.dailyTotals[day].rxBytes,
    txBytes: history.dailyTotals[day].txBytes,
  }));
  const todayTotal = last30.length ? last30[last30.length - 1] : { rxBytes: 0, txBytes: 0 };
  const monthTotal = last30.reduce((sum, d) => sum + d.rxBytes + d.txBytes, 0);

  return {
    current: { rxBytes: stats.rxBytes, txBytes: stats.txBytes, rxBytesLabel: formatBytes(stats.rxBytes), txBytesLabel: formatBytes(stats.txBytes) },
    today: { rxBytes: todayTotal.rxBytes, txBytes: todayTotal.txBytes, rxBytesLabel: formatBytes(todayTotal.rxBytes), txBytesLabel: formatBytes(todayTotal.txBytes) },
    monthTotalBytes: monthTotal,
    monthTotalBytesLabel: formatBytes(monthTotal),
    dailyHistory: last30,
    dockerContainers: getDockerContainerStats(),
    r2: getR2Usage(),
  };
}

module.exports = { scheduleBandwidthSampler, sampleAndRecord, getSummary, formatBytes };
