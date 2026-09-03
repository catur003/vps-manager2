const path = require('path');
const crypto = require('crypto');
const shell = require('../utils/shell');

const WRAPPER_PATH = path.join(__dirname, '..', '..', 'scripts', 'cron-wrapper.sh');
// Regex buat kenalin baris crontab yang dibungkus wrapper kita, sekaligus
// ekstrak jobId + command ASLI di dalamnya (buat ditampilin ke user apa
// adanya, bukan nyodorin internal "cron-wrapper.sh xxx '...'" yang bikin
// bingung). Command asli disimpan dalam TANDA KUTIP TUNGGAL - escape yang
// dipakai cuma `'\''` (pola standar shell buat quote-dalam-quote).
const WRAPPED_LINE_REGEX = new RegExp(`^${WRAPPER_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\S+) '(.*)'$`);

function unescapeSingleQuotes(str) {
  return str.replace(/'\\''/g, "'");
}

function escapeSingleQuotes(str) {
  return str.replace(/'/g, "'\\''");
}

/**
 * Bungkus command asli pakai cron-wrapper.sh + jobId baru (random, stabil
 * dipakai sebagai kunci pencocokan history run - lihat getHistory()).
 */
function wrapCommand(command) {
  const jobId = crypto.randomBytes(4).toString('hex');
  return `${WRAPPER_PATH} ${jobId} '${escapeSingleQuotes(command.trim())}'`;
}

/**
 * Manajemen crontab PER USER - selalu lewat `sudo -u <user> crontab ...`
 * (jadi crontab MILIK user itu sendiri), BUKAN `crontab -u <user>` sebagai
 * root - konsisten sama pola shell.runAsUser() yang dipakai di seluruh
 * codebase ini (operasi "jadi user itu", bukan "root ngatur user itu").
 */

const CRON_LINE_REGEX = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/;

/**
 * `crontab -l` exit code 1 kalau user itu BELUM PUNYA crontab sama sekali -
 * kondisi VALID (bukan error), sama pola dengan grep/sshd_config di
 * security.js. Dibedain dari kegagalan beneran (mis. permission) lewat exit
 * code: 1 = kosong, selain itu = error asli.
 */
function list(user) {
  const result = shell.runAsUser(user, 'crontab -l', { silent: true });
  if (!result.ok) {
    if (result.exitCode === 1) return { ok: true, entries: [] };
    return { ok: false, errorMessage: result.errorMessage, entries: [] };
  }

  const lines = result.output.split('\n');
  const entries = [];
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) return;
    const isDisabled = line.startsWith('#DISABLED#');
    const effectiveLine = isDisabled ? line.replace('#DISABLED#', '').trim() : line;
    if (effectiveLine.startsWith('#')) return; // komentar biasa (bukan format disable kita) - skip dari list, biar gak ke-parse sebagai job rusak

    const match = effectiveLine.match(CRON_LINE_REGEX);
    if (!match) return;

    // Kalau command-nya dibungkus cron-wrapper.sh (job yang dibuat/di-edit
    // lewat panel ini), tampilkan command ASLI-nya ke user (bukan internal
    // wrapper-nya) + jobId buat disambungkan ke history run.
    const wrappedMatch = match[2].match(WRAPPED_LINE_REGEX);
    entries.push({
      index, // posisi baris ASLI (termasuk komentar/baris kosong) - dipakai referensi update/hapus, BUKAN index ke array `entries` ini
      schedule: match[1],
      command: wrappedMatch ? unescapeSingleQuotes(wrappedMatch[2]) : match[2],
      jobId: wrappedMatch ? wrappedMatch[1] : null,
      enabled: !isDisabled,
      raw: rawLine,
    });
  });
  return { ok: true, entries };
}

/**
 * Baca history run job yang PERNAH dijalankan cron-wrapper.sh (jobId muncul
 * di history CUMA setelah job itu pernah beneran ke-trigger sama cron
 * daemon - job yang barusan ditambah tapi belum sempat jalan bakal balik
 * lastRun: null, itu wajar bukan bug). File history-nya milik user itu
 * sendiri (`~/.vps-manager-cron-history.jsonl`), dibaca lewat shell.runAsUser
 * biar konsisten sama cara baca crontab.
 */
function getHistory(user, jobId, limit = 10) {
  const result = shell.runAsUser(user, 'cat ~/.vps-manager-cron-history.jsonl 2>/dev/null || true', { silent: true });
  if (!result.ok) return { ok: true, runs: [] };
  const lines = result.output.split('\n').filter(Boolean);
  const runs = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.jobId === jobId) runs.push(parsed);
    } catch (err) {
      // baris korup/gak lengkap (mis. sempat ke-interrupt pas nulis) - skip diam-diam
    }
  }
  runs.reverse(); // terbaru duluan
  return { ok: true, runs: runs.slice(0, limit) };
}

function isValidSchedule(schedule) {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fieldPattern = /^(\*|\d+)(-(\d+))?(\/\d+)?(,(\*|\d+)(-(\d+))?(\/\d+)?)*$/;
  return parts.every((p) => fieldPattern.test(p));
}

/**
 * Tulis ulang SELURUH crontab dari array baris mentah - dipakai internal
 * oleh add/update/remove/toggle, BUKAN diekspos langsung (biar semua
 * perubahan tetap lewat validasi command masing-masing fungsi).
 */
function writeRawLines(user, lines) {
  const content = lines.join('\n') + (lines.length ? '\n' : '');
  const result = shell.runAsUser(user, 'crontab -', { input: content, silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  return { ok: true };
}

function getRawLines(user) {
  const result = shell.runAsUser(user, 'crontab -l', { silent: true });
  if (!result.ok) return result.exitCode === 1 ? [] : null;
  return result.output.split('\n').filter((l, i, arr) => !(l === '' && i === arr.length - 1)); // buang trailing empty line doang
}

function add(user, schedule, command) {
  if (!isValidSchedule(schedule)) {
    return { ok: false, errorMessage: 'Format jadwal cron tidak valid. Harus 5 field (menit jam tanggal bulan hari), mis. "0 2 * * *".' };
  }
  if (!command || typeof command !== 'string' || !command.trim()) {
    return { ok: false, errorMessage: 'Command wajib diisi.' };
  }
  const lines = getRawLines(user);
  if (lines === null) return { ok: false, errorMessage: 'Gagal baca crontab user ini.' };
  lines.push(`${schedule.trim()} ${wrapCommand(command)}`);
  return writeRawLines(user, lines);
}

function update(user, lineIndex, schedule, command) {
  if (!isValidSchedule(schedule)) {
    return { ok: false, errorMessage: 'Format jadwal cron tidak valid.' };
  }
  const lines = getRawLines(user);
  if (lines === null) return { ok: false, errorMessage: 'Gagal baca crontab user ini.' };
  if (lineIndex < 0 || lineIndex >= lines.length) return { ok: false, errorMessage: 'Baris cron tidak ditemukan (mungkin sudah berubah - refresh dulu).' };

  const wasDisabled = lines[lineIndex].trim().startsWith('#DISABLED#');
  // Pertahankan jobId lama kalau baris ini sudah dibungkus wrapper
  // sebelumnya (biar history run lama gak putus nyambung), generate baru
  // cuma kalau ini pertama kalinya baris ini di-edit lewat panel.
  const existingLine = (wasDisabled ? lines[lineIndex].replace('#DISABLED#', '') : lines[lineIndex]).trim();
  const existingMatch = existingLine.match(CRON_LINE_REGEX);
  const existingWrapped = existingMatch && existingMatch[2].match(WRAPPED_LINE_REGEX);
  const wrappedCommand = existingWrapped
    ? `${WRAPPER_PATH} ${existingWrapped[1]} '${escapeSingleQuotes(command.trim())}'`
    : wrapCommand(command);

  lines[lineIndex] = `${wasDisabled ? '#DISABLED#' : ''}${schedule.trim()} ${wrappedCommand}`;
  return writeRawLines(user, lines);
}

function remove(user, lineIndex) {
  const lines = getRawLines(user);
  if (lines === null) return { ok: false, errorMessage: 'Gagal baca crontab user ini.' };
  if (lineIndex < 0 || lineIndex >= lines.length) return { ok: false, errorMessage: 'Baris cron tidak ditemukan (mungkin sudah berubah - refresh dulu).' };
  lines.splice(lineIndex, 1);
  return writeRawLines(user, lines);
}

/**
 * Enable/disable job TANPA hapus - prefix `#DISABLED#` di depan baris
 * (bukan comment-out polos `#`) biar gampang dibedain dari komentar biasa
 * user pas di-parse ulang di list().
 */
function toggle(user, lineIndex) {
  const lines = getRawLines(user);
  if (lines === null) return { ok: false, errorMessage: 'Gagal baca crontab user ini.' };
  if (lineIndex < 0 || lineIndex >= lines.length) return { ok: false, errorMessage: 'Baris cron tidak ditemukan (mungkin sudah berubah - refresh dulu).' };

  const line = lines[lineIndex];
  lines[lineIndex] = line.trim().startsWith('#DISABLED#') ? line.replace('#DISABLED#', '').trim() : `#DISABLED#${line}`;
  return writeRawLines(user, lines);
}

/**
 * Ambil run TERAKHIR tiap jobId sekaligus (1x baca file, bukan N kali per
 * job) - dipakai GET /cron biar list dashboard langsung nunjukin kolom
 * "last run" tanpa request terpisah per job.
 */
function getLastRuns(user) {
  const result = shell.runAsUser(user, 'cat ~/.vps-manager-cron-history.jsonl 2>/dev/null || true', { silent: true });
  if (!result.ok) return {};
  const lines = result.output.split('\n').filter(Boolean);
  const lastByJobId = {};
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      lastByJobId[parsed.jobId] = parsed; // file append-only urut waktu, jadi yang terakhir ketimpa = paling baru
    } catch (err) {
      // baris korup - skip diam-diam
    }
  }
  return lastByJobId;
}

module.exports = { list, add, update, remove, toggle, isValidSchedule, getHistory, getLastRuns };
