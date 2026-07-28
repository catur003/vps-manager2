const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../utils/safeFile');
const secretCrypto = require('../utils/secretCrypto');

// Field yang mengandung kredensial mentah - dienkripsi saat storage, didekripsi
// on-the-fly pas dibaca. `connectionUrl` ikut dienkripsi juga karena formatnya
// "mysql://user:PASSWORD@host/db" - password-nya nempel di situ juga, kalau
// cuma field `password` yang dienkripsi tapi connectionUrl dibiarkan mentah,
// password-nya tetap bocor plaintext lewat field itu (percuma).
const SENSITIVE_FIELDS = ['password', 'connectionUrl'];

const DB_REGISTRY_PATH = path.join(__dirname, '..', '..', 'data', 'db-registry.json');

/**
 * Registry lokal buat "mengingat" kredensial database yang tool ini tahu
 * (hasil Buat Database Baru atau Import Database manual) - supaya nanti bisa
 * dipilih dari list (misal pas Deploy Project Baru), BUKAN diketik ulang
 * connection string-nya tiap kali.
 *
 * Beda dengan config.json (kredensial ROOT MySQL, satu buat semua), file ini
 * nyimpen kredensial per-database (dbUser + password khusus tiap db).
 */

function ensureFile() {
  const dir = path.dirname(DB_REGISTRY_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_REGISTRY_PATH)) {
    atomicWriteJSON(DB_REGISTRY_PATH, [], 0o600);
  }
  try {
    fs.chmodSync(DB_REGISTRY_PATH, 0o600); // defense-in-depth buat file lama sebelum fix ini
  } catch (err) {
    // biarin lanjut walau chmod gagal, jangan sampai bikin tool berhenti total
  }
}

function decryptEntry(entry) {
  const out = { ...entry };
  for (const field of SENSITIVE_FIELDS) {
    if (out[field] !== undefined) out[field] = secretCrypto.decrypt(out[field]);
  }
  return out;
}

function encryptEntry(entry) {
  const out = { ...entry };
  for (const field of SENSITIVE_FIELDS) {
    if (out[field] !== undefined) out[field] = secretCrypto.encrypt(out[field]);
  }
  return out;
}

/**
 * Baca entry MENTAH dari disk (masih terenkripsi) - dipakai internal buat
 * saveAll()/upsertEntry()/removeEntry() supaya nulis ulang file nggak
 * "menimpa terenkripsi jadi plaintext" gara-gara baca hasil decrypt lalu
 * ditulis lagi tanpa encrypt ulang.
 */
function loadAllRaw() {
  ensureFile();
  const raw = fs.readFileSync(DB_REGISTRY_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    return [];
  }
}

/**
 * Baca semua entry dengan kredensial SUDAH didekripsi - ini yang dipakai
 * caller (menu, API) seperti biasa, jadi behavior lama (dapet password
 * plaintext buat auto-fill DATABASE_URL, testCredentials, dll) tetap sama
 * persis, cuma sekarang di disk-nya nggak lagi plaintext.
 */
function loadAll() {
  return loadAllRaw().map(decryptEntry);
}

function saveAll(entries) {
  ensureFile();
  atomicWriteJSON(DB_REGISTRY_PATH, entries.map(encryptEntry), 0o600);
}

/**
 * Simpan/update satu entry database. Kalau dbName sudah ada, ditimpa
 * (misal abis reset password) bukan dobel.
 * PENTING: terima & simpan SEMUA field yang dikirim caller (spread, bukan
 * destructure eksplisit) - dulu sempat cuma nyimpen {dbName, dbUser, password,
 * connectionUrl} dan diam-diam BUANG field lain seperti `usedByProject`,
 * padahal itu dipakai di banyak tempat (menu pilih DB existing, detail DB,
 * konfirmasi drop DB) buat nampilin "database ini dipakai project mana".
 */
function upsertEntry(entry) {
  if (!entry || !entry.dbName) throw new Error('upsertEntry butuh field dbName.');
  const entries = loadAll().filter((e) => e.dbName !== entry.dbName);
  entries.push({ ...entry, savedAt: new Date().toISOString() });
  saveAll(entries);
}

function listEntries() {
  return loadAll();
}

function findByName(dbName) {
  return loadAll().find((e) => e.dbName === dbName) || null;
}

function removeEntry(dbName) {
  const entries = loadAll().filter((e) => e.dbName !== dbName);
  saveAll(entries);
}

module.exports = { upsertEntry, listEntries, findByName, removeEntry };
