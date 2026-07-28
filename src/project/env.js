const crypto = require('crypto');
const shell = require('../utils/shell');

/**
 * Baca isi .env sebuah project (sebagai deploy_user-nya, bukan root).
 * Sebelumnya command ini dijalankan langsung dari mainMenu.js (menu
 * "View .env" / "Edit .env"), dipindah ke sini supaya reusable dari
 * CLI/bot/web nanti.
 */
function readEnv(projectPath, deployUser) {
  const result = shell.runAsUser(
    deployUser,
    `cat "${projectPath}/.env" 2>/dev/null`,
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
