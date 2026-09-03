const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_LOG_PATH = path.join(__dirname, '..', '..', 'data', 'audit.log');
const SENSITIVE_KEY_PATTERN = /password|token|secret|key|cloneurl/i;
// Defense-in-depth: `cloneUrl` (dan field APAPUN ke depannya) bisa nyimpen
// PAT GitHub tersisip di URL sendiri (https://user:TOKEN@github.com/...) -
// BUKAN cuma dicek dari nama field-nya (yang di atas), tapi juga dari BENTUK
// value-nya, biar field baru yang belum kepikiran namanya tetap ketangkep.
// Ditemukan sebagai bug nyata: cloneUrl LOLOS dari redact() lama (nama
// field-nya gak match /password|token|secret|key/) dan PAT-nya kejadi ke
// data/audit.log mentah-mentah tiap kali deploy repo private.
const EMBEDDED_CREDENTIAL_PATTERN = /^(https?:\/\/)[^/\s@]+@/i;

function ensureDir() {
  const dir = path.dirname(AUDIT_LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendLine(obj) {
  ensureDir();
  fs.appendFileSync(AUDIT_LOG_PATH, `${JSON.stringify(obj)}\n`);
}

/**
 * Ganti value field yang namanya kecium sensitif (password/token/secret/key)
 * jadi '[REDACTED]', rekursif ke nested object. Audit log sendiri jangan
 * sampai jadi sumber kebocoran credential baru.
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
  if (typeof value === 'string' && EMBEDDED_CREDENTIAL_PATTERN.test(value)) {
    return value.replace(/^(https?:\/\/)[^@/]+@/i, '$1[REDACTED]@');
  }
  return value;
}

/**
 * WAJIB dipanggil SEBELUM command dijalankan. Kalau proses crash di
 * tengah eksekusi (sebelum recordEnd() sempat jalan), baris "start" ini
 * tetap ada di disk - jadi ada jejak, bukan aksi yang hilang begitu saja.
 * Return auditId buat disambungkan ke recordEnd() setelah command selesai.
 */
function recordStart({ action, ip, params }) {
  const auditId = crypto.randomUUID();
  appendLine({
    auditId,
    event: 'start',
    action,
    ip: ip || null,
    params: redact(params || {}),
    at: new Date().toISOString(),
  });
  return auditId;
}

/**
 * Dipanggil setelah command selesai (sukses ATAUPUN gagal - selalu dipanggil,
 * biasanya dari blok finally).
 */
function recordEnd(auditId, { success, message, durationMs }) {
  appendLine({
    auditId,
    event: 'end',
    success: !!success,
    message: message || '',
    durationMs: durationMs ?? null,
    at: new Date().toISOString(),
  });
}

module.exports = { recordStart, recordEnd, redact, AUDIT_LOG_PATH };
