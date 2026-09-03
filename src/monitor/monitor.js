const os = require('os');
const shell = require('../utils/shell');

function getCpuUsage() {
  const result = shell.run("top -bn1 | grep 'Cpu(s)'", { silent: true });
  if (!result.ok) return null;
  const match = result.output.match(/(\d+\.\d+)\s*id/);
  if (!match) return null;
  const idle = parseFloat(match[1]);
  return Math.round((100 - idle) * 10) / 10;
}

function getRam() {
  const result = shell.run('free -m', { silent: true });
  if (!result.ok) return null;
  const lines = result.output.split('\n');
  const memLine = lines.find((l) => l.startsWith('Mem:'));
  if (!memLine) return null;
  const parts = memLine.split(/\s+/).map(Number);
  const [, total, used, , , available] = parts;
  return {
    totalMB: total,
    usedMB: used,
    availableMB: available || total - used,
    percent: Math.round((used / total) * 1000) / 10,
  };
}

function getSwap() {
  const result = shell.run('free -m', { silent: true });
  if (!result.ok) return null;
  const lines = result.output.split('\n');
  const swapLine = lines.find((l) => l.startsWith('Swap:'));
  if (!swapLine) return null;
  const parts = swapLine.split(/\s+/).map(Number);
  const [, total, used, free] = parts;
  if (!total) return { totalMB: 0, usedMB: 0, freeMB: 0, percent: 0 };
  return {
    totalMB: total,
    usedMB: used,
    freeMB: free ?? total - used,
    percent: Math.round((used / total) * 1000) / 10,
  };
}

function parseDfLine(line) {
  const parts = line.trim().split(/\s+/);
  return {
    filesystem: parts[0],
    total: parts[1],
    used: parts[2],
    available: parts[3],
    percent: parseInt(parts[4], 10),
    mount: parts[5],
  };
}

/**
 * VPS ini punya disk terpisah (mis. `/data` sebagai block volume tambahan di
 * luar boot disk `/`), jadi kalau cuma cek `df -h /` datanya bakal jauh lebih
 * kecil dari kapasitas asli - lihat catatan bug di percakapan (root disk 45GB
 * padahal `/data` 146GB). Di sini kita ambil SEMUA mount fisik (`df -hP`,
 * exclude tmpfs/devtmpfs/overlay/dsb) biar overview nunjukin total real.
 */
function formatGB(bytes) {
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + 'G';
}

/**
 * FIXED: widget "Resource Usage" (sidebar) sebelumnya cuma nampilin mount
 * PERTAMA (root disk `/`, 45GB) dan gak pernah ngitung `/data` (146GB) sama
 * sekali - user report langsung "disk ga kebaca yang 149gb". `-hP` (human
 * readable) gak bisa dijumlahin akurat antar mount (unit beda-beda,
 * pembulatan), jadi di sini SEKALIAN ambil versi byte mentah (`-B1`) buat
 * hitung agregat SEMUA disk fisik gabungan - dipakai widget sidebar biar
 * representatif ke kapasitas beneran, bukan cuma boot disk.
 */
function getDisk() {
  const result = shell.run("df -hP -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs", { silent: true });
  const bytesResult = shell.run("df -B1 -P -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs", { silent: true });
  if (!result.ok) return null;
  const lines = result.output.trim().split('\n').slice(1).filter(Boolean);
  const mounts = lines.map(parseDfLine);
  const root = mounts.find((m) => m.mount === '/') || mounts[0] || null;
  if (!root) return null;

  let aggregate = null;
  if (bytesResult.ok) {
    const byteLines = bytesResult.output.trim().split('\n').slice(1).filter(Boolean);
    const byteMounts = byteLines.map(parseDfLine); // total/used/available di sini masih dalam BYTE (bukan human)
    const totalBytes = byteMounts.reduce((sum, m) => sum + (parseInt(m.total, 10) || 0), 0);
    const usedBytes = byteMounts.reduce((sum, m) => sum + (parseInt(m.used, 10) || 0), 0);
    if (totalBytes > 0) {
      aggregate = {
        total: formatGB(totalBytes),
        used: formatGB(usedBytes),
        available: formatGB(totalBytes - usedBytes),
        percent: Math.round((usedBytes / totalBytes) * 1000) / 10,
      };
    }
  }

  return { ...root, mounts, aggregate: aggregate || root };
}

function getUptime() {
  const result = shell.run('uptime -p', { silent: true });
  return result.ok ? result.output.replace(/^up\s*/, '') : null;
}

function getLoadAverage() {
  const result = shell.run('uptime', { silent: true });
  if (!result.ok) return null;
  const match = result.output.match(/load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!match) return null;
  return { '1min': match[1], '5min': match[2], '15min': match[3] };
}

/**
 * Ambil semua metrics sekaligus jadi satu snapshot.
 */
function getStatus() {
  return {
    cpuPercent: getCpuUsage(),
    ram: getRam(),
    swap: getSwap(),
    disk: getDisk(),
    uptime: getUptime(),
    loadAverage: getLoadAverage(),
  };
}

/**
 * Cek apakah 1 port TCP lagi dipakai proses lain - dipanggil dari form
 * Deploy SEBELUM submit, biar ketauan bentrok port sebelum app/container
 * dijalankan (bukan ketauan belakangan lewat error "address already in
 * use"). `ss -ltn` gak butuh sudo buat cuma liat ada/nggaknya listener
 * (nama proses butuh sudo, tapi itu bukan yang dibutuhkan di sini).
 */
function checkPort(port) {
  const p = parseInt(port, 10);
  if (!Number.isFinite(p) || p < 1 || p > 65535) {
    return { ok: false, errorMessage: 'Nomor port tidak valid (1-65535).' };
  }
  const result = shell.runArgs('ss', ['-ltn'], { silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  // Kolom ke-4 (index 3) = "Local Address:Port" (mis. "127.0.0.1:4001",
  // "*:3000", "[::]:631") - JANGAN cuma cari pola ":<port>" di baris mentah,
  // soalnya "ss -ltn" nge-pad kolom terakhir ("Process") dengan spasi di
  // ujung baris, bikin anchor `$` regex sebelumnya SELALU gagal match -> port
  // yang lagi dipakai pun kelaporan "available" (bug nyata, ketauan pas
  // verifikasi live: port 4001 yang jelas-jelas dipakai vps-manager-api
  // sendiri kelaporan available:true).
  const lines = result.output.split('\n').slice(1).filter(Boolean);
  const inUse = lines.some((line) => {
    const cols = line.trim().split(/\s+/);
    const localAddr = cols[3] || '';
    const match = localAddr.match(/:(\d+)$/);
    return match && parseInt(match[1], 10) === p;
  });

  return { ok: true, port: p, available: !inUse };
}

/**
 * Info server yang RELATIF statis (gak perlu di-refresh sesering
 * CPU/RAM) - buat kartu "Server Information" di Overview. Semua dari
 * sumber nyata (Node `os` module + /etc/os-release), TIDAK ADA field yang
 * di-fake/hardcode kayak "Plan"/"Location" di mockup referensi (VPS
 * generik gak punya data itu tanpa integrasi provider tertentu).
 */
function getOsPrettyName() {
  const result = shell.run("grep '^PRETTY_NAME=' /etc/os-release", { silent: true });
  if (!result.ok || !result.output) return os.type();
  const match = result.output.match(/PRETTY_NAME="?([^"]+)"?/);
  return match ? match[1] : os.type();
}

function getServerInfo() {
  return {
    hostname: os.hostname(),
    os: getOsPrettyName(),
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: (os.cpus()[0] || {}).model || null,
    cpuCores: os.cpus().length,
    totalRamMB: Math.round(os.totalmem() / 1024 / 1024),
  };
}

module.exports = { getCpuUsage, getRam, getSwap, getDisk, getUptime, getLoadAverage, getStatus, checkPort, getServerInfo };
