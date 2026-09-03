const crypto = require('crypto');
const shell = require('../utils/shell');

/**
 * Baca isi .env sebuah project (sebagai deploy_user-nya, bukan root).
 * Sebelumnya command ini dijalankan langsung dari mainMenu.js (menu
 * "View .env" / "Edit .env"), dipindah ke sini supaya reusable dari
 * CLI/bot/web nanti.
 */
/**
 * FIX: sebelumnya pakai `cat ".../.env" 2>/dev/null` doang - `2>/dev/null`
 * cuma nge-buang PESAN error, exit code `cat` tetap non-zero kalau file-nya
 * gak ada. Project yang emang belum pernah dikasih .env (valid, bukan error -
 * mis. semua config di-hardcode atau baru pertama kali di-deploy) jadi selalu
 * dilaporkan "Gagal membaca .env project" walau sebenarnya cuma belum ada
 * filenya. Sekarang dicek eksplisit: kalau file gak ada, balikin string
 * kosong (ok:true) - user bisa langsung mulai isi dari kosong, bukan
 * ke-block sama pesan gagal yang salah diagnosis.
 */
function readEnv(projectPath, deployUser) {
  const result = shell.runAsUser(
    deployUser,
    `if [ -f "${projectPath}/.env" ]; then cat "${projectPath}/.env"; else echo -n ""; fi`,
    { silent: true }
  );
  return { ok: result.ok, content: result.output || '' };
}

/**
 * Tulis ulang .env sebuah project. Pakai heredoc biar isi apapun (termasuk
 * yang ada tanda kutip/`$`) aman ditulis apa adanya, gak di-interpret shell.
 *
 * PENTING: delimiter heredoc di-random tiap panggilan (bukan fixed string),
 * karena `envContent` sekarang bisa datang dari luar (lewat API, bukan cuma
 * diketik sendiri di CLI). Kalau delimiter fixed (mis. selalu
 * "VPSMGR_ENV_EOF") dan `content` kebetulan/sengaja ada baris yang PERSIS
 * sama, heredoc berhenti lebih awal - sisa `content` sesudah baris itu bakal
 * dieksekusi sebagai command shell beneran (command injection), bukan
 * ketulis sebagai teks .env. Delimiter random bikin ini gak bisa ditebak.
 */
function writeEnv(projectPath, deployUser, content) {
  const delimiter = `VPSMGR_ENV_${crypto.randomBytes(12).toString('hex')}`;
  return shell.runAsUser(
    deployUser,
    `cat > .env << '${delimiter}'\n${content}\n${delimiter}`,
    { cwd: projectPath }
  );
}

module.exports = { readEnv, writeEnv };
