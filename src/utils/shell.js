const { execSync, spawnSync, execFileSync } = require('child_process');
const logger = require('./logger');

/**
 * Jalankan command shell dan kembalikan output-nya.
 * Melempar error jika command gagal (biar caller bisa handle safety/rollback).
 *
 * `timeoutMs` opsional - kalau diisi, command dipaksa berhenti (SIGTERM)
 * setelah durasi tsb dan dianggap gagal dengan pesan jelas, BUKAN nunggu
 * selamanya. Penting buat step yang bisa nyangkut kalau network/DB lambat
 * atau gak reachable (mis. `prisma db push`, `npm install`, `npm run build`).
 */
function run(command, options = {}) {
  const { silent = false, cwd = process.cwd(), maxBuffer, timeoutMs, input } = options;
  if (!silent) logger.info(`Menjalankan: ${command}`);
  try {
    const execOptions = { cwd, stdio: 'pipe' };
    if (maxBuffer) execOptions.maxBuffer = maxBuffer;
    if (timeoutMs) execOptions.timeout = timeoutMs;
    if (input !== undefined) execOptions.input = input;
    const output = execSync(command, execOptions).toString().trim();
    return { ok: true, output };
  } catch (err) {
    // PENTING: execSync TIDAK set err.killed=true saat timeout (beda dari
    // dokumentasi yang dikira sebelumnya) - yang beneran muncul adalah
    // err.signal (mis. 'SIGTERM') dan err.message mengandung "ETIMEDOUT".
    // Dicek dan dibuktikan langsung lewat scripts/test-fixes.js.
    const isTimeout = timeoutMs && (err.signal || /ETIMEDOUT/i.test(err.message || ''));
    if (isTimeout) {
      return {
        ok: false,
        output: err.stdout ? err.stdout.toString() : '',
        errorMessage: `Command timeout setelah ${Math.round(timeoutMs / 1000)} detik, proses dihentikan paksa (${err.signal || 'SIGTERM'}). Kemungkinan nyangkut nunggu network/DB yang gak reachable.`,
      };
    }
    // err.stderr SELALU berupa Buffer (truthy walau isinya kosong), jadi cek
    // panjangnya dulu - kalau langsung `err.stderr ? ... : err.message`,
    // fallback ke err.message ini gak akan pernah kepakai walau stderr kosong.
    const stderrText = err.stderr && err.stderr.length > 0 ? err.stderr.toString() : '';
    return {
      ok: false,
      output: err.stdout ? err.stdout.toString() : '',
      errorMessage: stderrText || err.message,
    };
  }
}

/**
 * Jalankan command sebagai user tertentu (misal deploy_user = www).
 * Wajib dipakai untuk clone/install/build sesuai prinsip Permission Manager.
 */
function runAsUser(user, command, options = {}) {
  // PENTING: paksa cwd ke /tmp (bisa diakses semua user).
  // Kalau proses induk (vps-manager) jalan dari /home/ubuntu (750, hanya owner),
  // user target (mis. www) gagal spawn dengan EACCES karena nggak bisa "masuk"
  // ke cwd tersebut, meski command-nya sendiri valid.
  const { cwd = '/tmp', ...rest } = options;
  const wrapped = `sudo -u ${user} bash -c '${command.replace(/'/g, "'\\''")}'`;
  return run(wrapped, { ...rest, cwd });
}

/**
 * Sama seperti run(), tapi TANPA shell sama sekali (execFileSync, bukan
 * execSync). `file` dan tiap elemen `args` dikirim sebagai argv langsung ke
 * proses child - shell (bash/sh) TIDAK PERNAH melihat/mem-parsing string
 * gabungannya, jadi metachar shell (`$()`, `;`, `&&`, `|`, kutip, dst) di
 * dalam `args` selalu diperlakukan sebagai teks literal, TIDAK PERNAH bisa
 * memicu eksekusi command tambahan - beda dari run() yang rawan kalau
 * salah satu bagian command dibangun dari input yang tidak divalidasi ketat
 * (mis. datang dari body request API).
 *
 * WAJIB dipakai (bukan run()) untuk command apapun yang salah satu
 * argumennya berasal dari input eksternal (request API) dan tidak
 * bisa/belum divalidasi dengan whitelist regex yang ketat.
 */
function runArgs(file, args, options = {}) {
  const { silent = false, cwd = process.cwd(), maxBuffer, timeoutMs, env, input } = options;
  if (!silent) logger.info(`Menjalankan: ${file} ${args.join(' ')}`);
  try {
    const execOptions = { cwd, stdio: 'pipe' };
    if (maxBuffer) execOptions.maxBuffer = maxBuffer;
    if (timeoutMs) execOptions.timeout = timeoutMs;
    if (env) execOptions.env = env;
    if (input !== undefined) execOptions.input = input;
    const output = execFileSync(file, args, execOptions).toString().trim();
    return { ok: true, output };
  } catch (err) {
    const isTimeout = timeoutMs && (err.signal || /ETIMEDOUT/i.test(err.message || ''));
    if (isTimeout) {
      return {
        ok: false,
        output: err.stdout ? err.stdout.toString() : '',
        errorMessage: `Command timeout setelah ${Math.round(timeoutMs / 1000)} detik, proses dihentikan paksa (${err.signal || 'SIGTERM'}). Kemungkinan nyangkut nunggu network/DB yang gak reachable.`,
      };
    }
    const stderrText = err.stderr && err.stderr.length > 0 ? err.stderr.toString() : '';
    return {
      ok: false,
      output: err.stdout ? err.stdout.toString() : '',
      errorMessage: stderrText || err.message,
    };
  }
}

/**
 * Versi runArgs() yang jalan sebagai user tertentu lewat sudo, TANPA
 * `bash -c` (beda dari runAsUser() yang lama). Karena gak lewat shell,
 * `user` dan seluruh `args` aman dikirim apa adanya walau mengandung
 * karakter aneh - execFileSync yang jamin itu semua jadi argv terpisah,
 * bukan digabung jadi satu string yang di-parse shell.
 */
function runAsUserArgs(user, file, args, options = {}) {
  const { cwd = '/tmp', ...rest } = options;
  return runArgs('sudo', ['-u', user, file, ...args], { ...rest, cwd });
}

/**
 * Cek apakah sebuah command/tool tersedia di sistem (mis: pm2, nginx, certbot).
 */
function commandExists(cmd) {
  const result = spawnSync('which', [cmd]);
  return result.status === 0;
}

module.exports = { run, runAsUser, runArgs, runAsUserArgs, commandExists };
