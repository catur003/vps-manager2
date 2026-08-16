const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJSON } = require('../../utils/safeFile');

const JOBS_PATH = path.join(__dirname, '..', '..', '..', 'data', 'jobs.json');
// "cloneurl" ditambahin di sini karena deploy.routes.js sekarang bisa
// nyisipin username:token GitHub ke params.cloneUrl (lihat buildAuthenticatedUrl
// di git.js) - tanpa "cloneurl" match regex ini, token itu bakal ke-expose
// mentah lewat GET /jobs/:id (toPublicJob cuma redact key yang match pattern).
const SENSITIVE_KEY_PATTERN = /password|token|secret|key|envcontent|cloneurl/i;
const MAX_STEP_MESSAGE_LENGTH = 4000;

// --- Auto-clean job history ---
// Jobs numpuk terus tiap deploy/SSL/build - tanpa batas, jobs.json bisa
// tumbuh gak abis-abis dan daftar Job di app jadi scroll gak berujung isinya
// history basi. Dua aturan retensi (yang mana duluan tercapai):
// 1. Job FINAL (bukan pending/running) yang lebih tua dari
//    JOB_RETENTION_DAYS dibuang otomatis.
// 2. Kalau jumlah job final masih lebih dari MAX_JOBS_KEPT, yang paling
//    lama dibuang duluan sampai pas MAX_JOBS_KEPT - biar app gak nge-render
//    ratusan job walau semuanya "baru" secara tanggal.
// Job yang MASIH pending/running TIDAK PERNAH dibuang otomatis, apapun
// umurnya - biar gak ilang track job yang somehow kepanjangan jalan.
const JOB_RETENTION_DAYS = 14;
const MAX_JOBS_KEPT = 50;
const FINAL_STATUSES = new Set(['success', 'failed', 'interrupted']);

/**
 * PENTING - dua fungsi beda tujuan, JANGAN dipakai ketuker:
 * - `redact()`   : dipakai HANYA saat menyiapkan data buat dikirim balik ke
 *                  client lewat API response (GET /jobs/:id, GET /jobs).
 * - `job.params` : disimpan ASLI (tidak diredact) di jobs.json, karena
 *                  deployWorker.js baca field ini buat BENERAN DIEKSEKUSI
 *                  (mis. isi .env). Kalau ini diredact, yang ketulis ke
 *                  .env project jadi literal "[REDACTED]" bukan value asli
 *                  - bug ini pernah kejadian, jangan diulang.
 * Karena jobs.json jadi nyimpen secret asli, file ini WAJIB chmod 600
 * (lihat ensureFile()), sama kayak config.json/db-registry.json.
 */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

/**
 * Siapin 1 job buat dikirim ke API response - redact params, biar secret
 * asli (DATABASE_URL, token, dll) gak pernah keluar lewat network sebagai
 * respons JSON, walau tetap ada di disk (jobs.json) buat kebutuhan worker.
 */
function toPublicJob(job) {
  if (!job) return job;
  return { ...job, params: redact(job.params) };
}

function ensureFile() {
  const dir = path.dirname(JOBS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(JOBS_PATH)) {
    atomicWriteJSON(JOBS_PATH, { jobs: {} }, 0o600);
  }
  try {
    fs.chmodSync(JOBS_PATH, 0o600); // nyimpen params asli (bisa berisi secret), sama kayak config.json
  } catch (err) {
    // biarin lanjut walau chmod gagal, jangan sampai bikin tool berhenti total
  }
}

function load() {
  ensureFile();
  return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
}

/**
 * Tulis lewat file temp lalu rename (atomic di level filesystem), biar kalau
 * proses mati PAS lagi nulis, file jobs.json yang lama tetap utuh - bukan
 * ke-truncate jadi setengah/corrupt. Ini penting karena jobs.json ditulis
 * berkali-kali per job (tiap step selesai), beda dari config.json/registry.json
 * yang jarang ditulis.
 */
function save(data) {
  ensureFile();
  atomicWriteJSON(JOBS_PATH, data, 0o600);
}

/**
 * Dipanggil sekali pas API baru start. Job yang statusnya masih
 * "pending"/"running" dari sebelum restart itu SUDAH PASTI gak lagi
 * beneran berjalan (prosesnya mati bareng API-nya) - ditandain
 * "interrupted" biar gak nge-hang selamanya keliatan kayak masih jalan.
 */
function reconcileInterruptedJobs() {
  const data = load();
  let changed = false;
  for (const job of Object.values(data.jobs)) {
    if (job.status === 'pending' || job.status === 'running') {
      job.status = 'interrupted';
      job.message = 'API restart di tengah proses - status akhir job ini gak diketahui, cek manual.';
      job.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (autoClean(data)) changed = true;
  if (changed) save(data);
}

/**
 * Terapin 2 aturan retensi di atas ke `data.jobs` LANGSUNG (mutate in-place),
 * return `true` kalau ada yang beneran kebuang (biar caller tau perlu save()
 * atau enggak). Dipanggil dari createJob() - self-cleaning tiap ada job baru
 * masuk, TANPA perlu cron/scheduler terpisah - dan dari reconcileInterruptedJobs()
 * pas API start, buat jaga-jaga kalau lama gak ada job baru sama sekali.
 */
function autoClean(data) {
  const before = Object.keys(data.jobs).length;
  const cutoffMs = Date.now() - JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let all = Object.values(data.jobs);
  all = all.filter((j) => !(FINAL_STATUSES.has(j.status) && new Date(j.updatedAt).getTime() < cutoffMs));

  const finalJobs = all
    .filter((j) => FINAL_STATUSES.has(j.status))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (finalJobs.length > MAX_JOBS_KEPT) {
    const toDrop = new Set(finalJobs.slice(MAX_JOBS_KEPT).map((j) => j.id));
    all = all.filter((j) => !toDrop.has(j.id));
  }

  const map = {};
  all.forEach((j) => {
    map[j.id] = j;
  });
  data.jobs = map;
  return Object.keys(map).length !== before;
}

function createJob(type, params) {
  const data = load();
  autoClean(data); // self-maintain retensi tiap ada job baru, lihat catatan di atas
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  data.jobs[id] = {
    id,
    type,
    params: params || {}, // ASLI, tidak diredact - lihat catatan di atas file
    status: 'pending',
    message: '',
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
  save(data);
  return id;
}

function updateJob(id, patch) {
  const data = load();
  if (!data.jobs[id]) return null;
  data.jobs[id] = { ...data.jobs[id], ...patch, updatedAt: new Date().toISOString() };
  save(data);
  return data.jobs[id];
}

/**
 * Tambah 1 entry ke `steps` job (dipanggil dari onStep callback tiap step
 * deploy/dll selesai), tanpa perlu caller kirim ulang array steps lengkap.
 * Pesan error dipotong ke MAX_STEP_MESSAGE_LENGTH karakter TERAKHIR (bukan
 * awal) kalau kepanjangan - baris error paling relevan dari output
 * npm/prisma/build biasanya ada di akhir, bukan di awal.
 */
function appendJobStep(id, step) {
  const data = load();
  if (!data.jobs[id]) return null;
  let message = step.message;
  if (typeof message === 'string' && message.length > MAX_STEP_MESSAGE_LENGTH) {
    message = `...(dipotong, ${message.length - MAX_STEP_MESSAGE_LENGTH} karakter awal dibuang)...\n${message.slice(-MAX_STEP_MESSAGE_LENGTH)}`;
  }
  data.jobs[id].steps.push({ ...step, message, at: new Date().toISOString() });
  data.jobs[id].updatedAt = new Date().toISOString();
  save(data);
  return data.jobs[id];
}

function getJob(id) {
  return load().jobs[id] || null;
}

function listJobs() {
  return Object.values(load().jobs).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/**
 * Hapus SATU job manual dari histori. Job yang masih pending/running
 * SENGAJA ditolak di sini (bukan cuma di route) - dua-duanya harus konsisten
 * nolak, biar fungsi ini aman dipanggil dari mana aja tanpa nginjek aturan
 * "jangan hapus yang masih jalan" berulang di tiap caller.
 */
function deleteJob(id) {
  const data = load();
  const job = data.jobs[id];
  if (!job) return { ok: false, reason: 'NOT_FOUND' };
  if (job.status === 'pending' || job.status === 'running') {
    return { ok: false, reason: 'STILL_RUNNING' };
  }
  delete data.jobs[id];
  save(data);
  return { ok: true };
}

/**
 * Bersihkan SEMUA job yang statusnya udah final (success/failed/interrupted)
 * sekaligus - dipakai tombol "Bersihkan Selesai" di app. Job yang masih
 * pending/running gak ikut kebuang (masih ada progress buat dipantau).
 * Return jumlah job yang kebuang.
 */
function clearFinishedJobs() {
  const data = load();
  const before = Object.keys(data.jobs).length;
  const kept = {};
  Object.values(data.jobs).forEach((job) => {
    if (!FINAL_STATUSES.has(job.status)) kept[job.id] = job;
  });
  data.jobs = kept;
  save(data);
  return before - Object.keys(kept).length;
}

module.exports = {
  createJob,
  updateJob,
  appendJobStep,
  getJob,
  listJobs,
  deleteJob,
  clearFinishedJobs,
  reconcileInterruptedJobs,
  toPublicJob,
  JOBS_PATH,
};
