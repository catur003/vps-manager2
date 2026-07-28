const fs = require('fs');
const { execSync } = require('child_process');

/**
 * Tulis JSON ke file secara ATOMIC: tulis ke file .tmp dulu, baru rename ke
 * path asli. Rename di level filesystem itu atomic, jadi kalau proses mati
 * PAS lagi nulis, file lama tetap utuh - gak ada skenario file ke-truncate
 * jadi setengah/corrupt. Dipakai di semua file data (registry, config,
 * db-registry, jobs) yang ditulis berkali-kali selama proses jalan.
 */
function atomicWriteJSON(filePath, data, mode = null) {
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  // chmod file .tmp SEBELUM rename, bukan sesudah - kalau `mode` diisi (mis.
  // 0o600 untuk file berisi kredensial kayak config.json/db-registry.json).
  // Rename tidak "mewarisi" permission dari file lama yang ditimpa; file
  // hasil rename ikut permission file .tmp saat dibuat. Tanpa ini, tiap kali
  // file ditulis ulang, permission-nya bisa balik ke default (644) - itu
  // regresi keamanan diam-diam padahal isinya password/API key.
  if (mode !== null) {
    try {
      fs.chmodSync(tmpPath, mode);
    } catch (err) {
      // biarin lanjut walau chmod gagal (mis. filesystem gak support),
      // daripada bikin write gagal total cuma gara-gara ini
    }
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Sleep SYNCHRONOUS (blocking) tanpa busy-wait yang makan CPU - pakai
 * command `sleep` OS asli lewat execSync. Dipakai buat retry delay pas
 * nunggu lock kepakai proses lain.
 */
function sleepSync(ms) {
  const seconds = Math.max(ms, 10) / 1000;
  try {
    execSync(`sleep ${seconds}`);
  } catch (err) {
    // kalau `sleep` command gak ada (harusnya selalu ada di Linux/Termux), abaikan
  }
}

/**
 * Lock sederhana berbasis filesystem, cross-process (bekerja walau
 * pemegang lock lain adalah proses Node yang beda - penting karena tiap
 * deploy job jalan sebagai proses fork() terpisah, bukan cuma beda thread).
 *
 * Pakai `fs.openSync(path, 'wx')` - flag 'wx' gagal (EEXIST) kalau file
 * sudah ada, jadi "berhasil buka" == "berhasil dapat lock".
 *
 * Ada stale-lock detection: kalau lock file umurnya lebih dari
 * `staleMs`, dianggap sisa proses yang crash (gak sempat unlock), dan
 * dihapus paksa supaya gak nge-block selamanya.
 */
function withFileLock(lockPath, fn, { timeoutMs = 5000, staleMs = 15000, retryDelayMs = 50 } = {}) {
  const start = Date.now();
  let acquired = false;

  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      acquired = true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Cek apakah lock ini "basi" (proses pemegang lock kemungkinan sudah mati)
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue; // langsung coba ambil lagi tanpa nunggu retryDelay
        }
      } catch (statErr) {
        // lock keburu dihapus proses lain barusan, coba ambil lagi
        continue;
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(`Gagal dapat lock "${lockPath}" setelah ${timeoutMs}ms (masih dipegang proses lain).`);
      }
      sleepSync(retryDelayMs);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (err) {
      // lock udah kehapus (mis. kena stale-cleanup proses lain), aman diabaikan
    }
  }
}

module.exports = { atomicWriteJSON, withFileLock, sleepSync };
