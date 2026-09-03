const shell = require('../utils/shell');

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
    entries.push({
      index, // posisi baris ASLI (termasuk komentar/baris kosong) - dipakai referensi update/hapus, BUKAN index ke array `entries` ini
      schedule: match[1],
      command: match[2],
      enabled: !isDisabled,
      raw: rawLine,
    });
  });
  return { ok: true, entries };
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
  lines.push(`${schedule.trim()} ${command.trim()}`);
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
  lines[lineIndex] = `${wasDisabled ? '#DISABLED#' : ''}${schedule.trim()} ${command.trim()}`;
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

module.exports = { list, add, update, remove, toggle, isValidSchedule };
