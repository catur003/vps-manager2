const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Encrypt-at-rest untuk kredensial sensitif (password database, dll) yang
 * BUTUH bisa dibalikin ke plaintext lagi (beda dari API key di config.js yang
 * cukup di-hash karena cuma perlu diverifikasi, bukan dipakai ulang).
 * db-registry.json nyimpen password user database yang dipakai ULANG secara
 * otomatis (auto-fill DATABASE_URL pas Deploy Project Baru) - jadi harus ada
 * jalan buat dapetin plaintext-nya lagi, makanya encrypt (AES-256-GCM),
 * bukan hash satu arah.
 *
 * Key disimpan terpisah dari data terenkripsi (data/.secret.key, permission
 * 600, digenerate sekali otomatis) - biar file kredensial (db-registry.json)
 * kalau kebaca/kecopy/ke-backup sendirian TIDAK otomatis bisa didekripsi
 * tanpa file key ini juga.
 */

const KEY_PATH = path.join(__dirname, '..', '..', 'data', '.secret.key');
const PREFIX = 'enc:v1:';

function getOrCreateKey() {
  const dir = path.dirname(KEY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(KEY_PATH)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
    return key;
  }
  try {
    fs.chmodSync(KEY_PATH, 0o600); // defense-in-depth, sama pola kayak config.json/db-registry.json
  } catch (err) {
    // biarin lanjut walau chmod gagal, jangan sampai bikin tool berhenti total
  }
  return fs.readFileSync(KEY_PATH);
}

/**
 * Encrypt string jadi format "enc:v1:<iv>:<authTag>:<ciphertext>" (semua hex).
 * Kalau input kosong/null, dibalikin apa adanya (nggak ada yang perlu dienkripsi).
 */
function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return plainText;
  if (typeof plainText !== 'string') return plainText; // jaga-jaga, jangan sampai crash gara-gara tipe salah
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Decrypt balik ke plaintext. Kalau value TERNYATA bukan format terenkripsi
 * (data lama sebelum fix ini, masih plaintext di disk), dibalikin APA ADANYA
 * - biar entry lama tetap kebaca & jalan seperti biasa (auto-migrate ke
 * terenkripsi begitu di-upsertEntry() ulang), bukan error/hilang diam-diam.
 */
function decrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  if (!isEncrypted(value)) return value; // data lama / belum dienkripsi, backward-compatible
  try {
    const key = getOrCreateKey();
    const [, , ivHex, authTagHex, cipherHex] = value.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encrypted = Buffer.from(cipherHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch (err) {
    // Gagal decrypt (key hilang/rusak/beda) - JANGAN pura-pura sukses dengan
    // balikin string kosong (bisa bikin auto-fill DATABASE_URL diam-diam
    // rusak tanpa pesan error). Balikin marker jelas biar caller/user tau
    // ada yang salah, bukan silent failure.
    return '[DECRYPT_FAILED]';
  }
}

module.exports = { encrypt, decrypt, isEncrypted, KEY_PATH };
