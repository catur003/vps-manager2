const shell = require('../utils/shell');

const SAFE_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function isValidContainerName(name) {
  return typeof name === 'string' && SAFE_CONTAINER_NAME.test(name);
}

/**
 * List semua container (jalan + berhenti). `sudo docker` (bukan grup
 * `docker`, lihat catatan di scripts/setup-sudoers.sh) - scoped ke
 * `docker ps`/`docker ps -a` doang.
 */
function listContainers() {
  const format = '{{.ID}}|{{.Image}}|{{.Names}}|{{.Status}}|{{.Ports}}|{{.RunningFor}}';
  const result = shell.runArgs('sudo', ['docker', 'ps', '-a', '--format', format], { silent: true });
  if (!result.ok) return { ok: false, containers: [], errorMessage: result.errorMessage };

  const containers = result.output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, image, names, status, ports, runningFor] = line.split('|');
      return {
        id,
        image,
        name: names,
        status,
        ports: ports || '',
        runningFor,
        running: /^Up /.test(status || ''),
      };
    });

  return { ok: true, containers };
}

function start(name) {
  if (!isValidContainerName(name)) return { ok: false, errorMessage: 'Nama container tidak valid.' };
  const result = shell.runArgs('sudo', ['docker', 'start', name]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

function stop(name) {
  if (!isValidContainerName(name)) return { ok: false, errorMessage: 'Nama container tidak valid.' };
  const result = shell.runArgs('sudo', ['docker', 'stop', name]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

/**
 * Deploy container BARU (`docker run -d`). Dipakai dari dashboard "Docker
 * Deploy" - beda dari start/stop/restart yang cuma ngontrol container yang
 * SUDAH ada. `ports`/`envVars` dikirim sebagai argv terpisah lewat runArgs
 * (execFileSync) - aman dari shell injection walau isinya aneh, cuma nama
 * image & container yang divalidasi ketat (whitelist regex) karena dua itu
 * juga dipakai di command lain (start/stop/restart/logs) yang sama-sama
 * ngandelin SAFE_CONTAINER_NAME.
 */
const MEMORY_LIMIT_REGEX = /^\d+[kmgKMG]$/;

function runContainer({ image, name, ports = [], envVars = {}, restartPolicy = 'unless-stopped', memoryLimit }) {
  if (!isValidContainerName(name)) return { ok: false, errorMessage: 'Nama container tidak valid.' };
  if (!image || typeof image !== 'string' || /\s/.test(image)) return { ok: false, errorMessage: 'Nama image tidak valid.' };
  if (memoryLimit && !MEMORY_LIMIT_REGEX.test(memoryLimit)) {
    return { ok: false, errorMessage: 'Format memoryLimit harus angka + satuan k/m/g (mis. "300m", "1g").' };
  }

  const args = ['docker', 'run', '-d', '--name', name, '--restart', restartPolicy];
  // Docker's own resource limit (cgroups) - beda level dari PM2's
  // --max-memory-restart (yang cuma soft-restart di level aplikasi Node) -
  // ini HARD limit kernel, container langsung di-kill (OOM) kalau kelewat,
  // gak nunggu app-nya "sadar diri" dulu.
  if (memoryLimit) args.push('--memory', memoryLimit);
  for (const p of ports) {
    if (typeof p === 'string' && /^\d+:\d+$/.test(p)) args.push('-p', p);
  }
  for (const [key, value] of Object.entries(envVars)) {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) args.push('-e', `${key}=${value}`);
  }
  args.push(image);

  const result = shell.runArgs('sudo', args);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true, containerId: result.output };
}

/**
 * Hapus container permanen (`docker rm -f`). Beda dari stop() yang cuma
 * berhenti - ini bikin container-nya hilang total, harus di-deploy ulang
 * lewat runContainer() kalau mau dipakai lagi. WAJIB confirm dari caller.
 */
function remove(name) {
  if (!isValidContainerName(name)) return { ok: false, errorMessage: 'Nama container tidak valid.' };
  const result = shell.runArgs('sudo', ['docker', 'rm', '-f', name]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

function restart(name) {
  if (!isValidContainerName(name)) return { ok: false, errorMessage: 'Nama container tidak valid.' };
  const result = shell.runArgs('sudo', ['docker', 'restart', name]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

function logs(name, lines = 100) {
  if (!isValidContainerName(name)) return { ok: false, errorMessage: 'Nama container tidak valid.' };
  const safeLines = Math.min(Math.max(parseInt(lines, 10) || 100, 1), 1000);
  const result = shell.runArgs('sudo', ['docker', 'logs', '--tail', String(safeLines), name], { silent: true, maxBuffer: 5 * 1024 * 1024 });
  // docker logs nulis ke stderr buat konten normal juga (bukan cuma error) -
  // kalau ok:false tapi ada output di errorMessage, itu kemungkinan besar
  // log asli, bukan error command-nya sendiri (docker exit code tetap 0
  // meski begitu; ini jaga-jaga kalau ada versi docker yang beda perilaku).
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true, output: result.output };
}

/**
 * CPU/Memory REAL per-container (`docker stats --no-stream`) - dipakai
 * kartu ringkasan (Total CPU/Memory Usage) & kolom CPU/Memory di tabel
 * container, BUKAN nomor kosong/placeholder.
 */
function getStats() {
  const format = '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}';
  const result = shell.runArgs('sudo', ['docker', 'stats', '--no-stream', '--format', format], { silent: true, timeoutMs: 15000 });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage, stats: [] };

  const stats = result.output.split('\n').filter(Boolean).map((line) => {
    const [name, cpuPerc, memUsage, memPerc] = line.split('|');
    return { name, cpuPercent: parseFloat(cpuPerc) || 0, memUsage, memPercent: parseFloat(memPerc) || 0 };
  });
  return { ok: true, stats };
}

module.exports = {
  listContainers,
  start,
  stop,
  restart,
  remove,
  runContainer,
  logs,
  getStats,
  isValidContainerName,
};
