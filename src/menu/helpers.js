// Pure helpers - TANPA inquirer/logger, gak ada I/O interaktif.
// Aman dipanggil dari mana aja (CLI, bot Telegram, web API) tanpa efek samping.

const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const DOMAIN_REGEX = /^[a-zA-Z0-9.-]+$/;

function validateName(input) {
  if (!input || !NAME_REGEX.test(input)) {
    return 'Hanya boleh huruf, angka, underscore, dan dash (tanpa spasi/simbol lain).';
  }
  return true;
}

function validateDomainOptional(input) {
  if (!input) return true; // boleh kosong di beberapa form (mis. Deploy Lama)
  if (!DOMAIN_REGEX.test(input)) {
    return 'Domain hanya boleh huruf, angka, titik, dan dash.';
  }
  return true;
}

function validateDomainRequired(input) {
  if (!input || !DOMAIN_REGEX.test(input)) {
    return 'Domain wajib diisi, hanya boleh huruf, angka, titik, dan dash.';
  }
  return true;
}

/**
 * Ambil port dari string target proxy (mis. "127.0.0.1:3000" -> "3000").
 */
function extractPortFromTarget(target) {
  const match = target && target.match(/:(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Render tabel teks rapi rata kolom dari headers + rows.
 */
function formatAlignedTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const renderRow = (cols) => cols.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  const separatorLength = widths.reduce((sum, w) => sum + w, 0) + (widths.length - 1) * 2;
  return [renderRow(headers), '─'.repeat(separatorLength), ...rows.map(renderRow)];
}

function levelColor(percent) {
  if (percent === null || percent === undefined) return 'blue';
  if (percent < 60) return 'green';
  if (percent < 85) return 'yellow';
  return 'red';
}

function levelEmoji(percent) {
  if (percent === null || percent === undefined) return '❔';
  if (percent < 60) return '✅';
  if (percent < 85) return '⚠️';
  return '🔥';
}

module.exports = {
  NAME_REGEX,
  validateName,
  validateDomainOptional,
  validateDomainRequired,
  extractPortFromTarget,
  formatAlignedTable,
  levelColor,
  levelEmoji,
};
