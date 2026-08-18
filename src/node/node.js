const path = require('path');
const shell = require('../utils/shell');

/**
 * Manajemen versi Node.js pakai nvm (Node Version Manager), PER USER (nvm
 * selalu diinstall ke $HOME user yang jalanin-nya, jadi user `www` dan
 * `catur` bisa punya daftar versi berbeda - relevan karena tiap project di
 * registry.js punya `deploy_user` sendiri-sendiri).
 *
 * Kenapa fitur ini ada: sebelumnya SEMUA project di satu server kepaksa
 * pakai satu versi Node yang sama (apapun yang default di PATH user itu) -
 * project lama yang butuh Node 16 gak bisa hidup bareng project baru yang
 * butuh Node 20 di server yang sama. Lewat sini, per-project bisa nge-pin
 * versi Node sendiri (disimpan di `project.node_version`), dipakai
 * pm2.js `start()` lewat override PATH ke folder bin versi tsb - lihat
 * komentar di pm2.js `nodePathPrefix()`.
 */

const NVM_INSTALL_SCRIPT_VERSION = 'v0.40.1'; // pin versi installer nvm biar hasilnya konsisten

/**
 * `sudo -u <user> bash -c '...'` (lihat shell.runAsUser) BUKAN login shell,
 * jadi ~/.bashrc/~/.profile TIDAK ke-source otomatis -> `nvm` gak ada di
 * PATH walau sudah terinstall. Semua command di file ini WAJIB nge-source
 * nvm.sh manual dulu lewat helper ini.
 */
function withNvm(command) {
  return `export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh" > /dev/null 2>&1 && ${command}`;
}

function isNvmInstalled(user) {
  const result = shell.runAsUser(user, withNvm('command -v nvm'), { silent: true });
  return result.ok && result.output.trim().length > 0;
}

/**
 * Install nvm buat user tsb pakai installer resmi nvm-sh. Butuh curl & git
 * (biasanya sudah ada di VPS) dan akses internet keluar dari server.
 */
function installNvm(user) {
  const installCmd = `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_INSTALL_SCRIPT_VERSION}/install.sh | bash`;
  const result = shell.runAsUser(user, installCmd, { timeoutMs: 120000 });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };
  if (!isNvmInstalled(user)) {
    return {
      ok: false,
      errorMessage: 'Installer nvm selesai jalan tapi nvm gak terdeteksi setelahnya. Cek manual: ls ~/.nvm di server (sebagai user tsb).',
    };
  }
  return { ok: true, output: result.output };
}

/**
 * Parse output `nvm ls --no-colors` jadi daftar versi + info current/default.
 * Format aslinya penuh whitespace/arrow indentation (mis. "->     v20.11.0",
 * "        v18.20.4", "default -> v20.11.0 (-> v20.11.0)") - diparse per baris,
 * cuma ambil token yang match pola versi (vX.Y.Z).
 */
function parseNvmLs(output) {
  const versions = [];
  let currentVersion = null;
  let defaultVersion = null;

  output.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    const match = line.match(/v\d+\.\d+\.\d+/);
    if (!match) return;
    const v = match[0];

    if (line.startsWith('default')) {
      defaultVersion = v;
      return; // baris alias "default", bukan entri versi terinstall
    }
    if (!versions.includes(v)) versions.push(v);
    if (line.startsWith('->')) currentVersion = v;
  });

  return { versions, currentVersion, defaultVersion };
}

function listInstalled(user) {
  if (!isNvmInstalled(user)) {
    return { ok: false, errorMessage: `nvm belum terinstall untuk user "${user}".`, versions: [], nvmInstalled: false };
  }
  const result = shell.runAsUser(user, withNvm('nvm ls --no-colors'), { silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage, versions: [], nvmInstalled: true };

  const parsed = parseNvmLs(result.output);
  return { ok: true, nvmInstalled: true, ...parsed };
}

/**
 * Validasi ringan format versi sebelum dikirim ke shell - nvm sendiri
 * nolak format aneh, tapi divalidasi dulu di sini biar pesan errornya jelas
 * dan mencegah string sembarang (dari body request API) nyusup ke command
 * shell (lihat shell.run - dijalanin lewat execSync, rawan kalau input gak
 * divalidasi ketat).
 */
function isValidVersionInput(version) {
  return /^v?\d+(\.\d+){0,2}$/.test(version) || /^(lts\/[\w.*-]+|node|stable)$/.test(version);
}

function installVersion(user, version) {
  if (!isValidVersionInput(version)) {
    return {
      ok: false,
      errorMessage: 'Format versi tidak valid. Contoh yang diterima: "18", "18.20.4", "v20.11.0", atau "lts/*".',
    };
  }
  if (!isNvmInstalled(user)) {
    const installResult = installNvm(user);
    if (!installResult.ok) return installResult;
  }
  return shell.runAsUser(user, withNvm(`nvm install ${version}`), { timeoutMs: 180000 });
}

/**
 * BUG FIX (laporan Zen: "hapus versi Node gak ilang dari list"): `nvm
 * uninstall` NOLAK hapus versi yang lagi dianggap "aktif" di sesi shell itu -
 * dan karena tiap `runAsUser()` selalu bikin sesi bash BARU, versi yang jadi
 * DEFAULT otomatis ke-resolve sebagai "aktif" begitu shell itu start (nvm
 * auto `use default` pas sourcing nvm.sh). Jadi coba hapus versi yang
 * kebetulan lagi default itu SELALU gagal (`nvm: Cannot uninstall
 * currently-active node version`), padahal user gak ngerasa lagi "pakai"
 * versi itu di mana pun. `nvm deactivate` dulu (idiom standar buat ini)
 * ngosongin status "aktif" buat sesi ini, baru `nvm uninstall` bisa jalan
 * apapun statusnya sebelumnya.
 */
function uninstallVersion(user, version) {
  if (!isValidVersionInput(version)) {
    return { ok: false, errorMessage: 'Format versi tidak valid.' };
  }
  return shell.runAsUser(user, withNvm(`nvm deactivate >/dev/null 2>&1; nvm uninstall ${version}`));
}

function setDefault(user, version) {
  if (!isValidVersionInput(version)) {
    return { ok: false, errorMessage: 'Format versi tidak valid.' };
  }
  return shell.runAsUser(user, withNvm(`nvm alias default ${version}`));
}

/**
 * Cari folder `bin` absolut buat versi Node tertentu milik user tsb (mis.
 * "/home/www/.nvm/versions/node/v20.11.0/bin") - dipakai pm2.js buat
 * nge-override PATH pas start app, BUKAN `--interpreter` pm2 (yang cuma
 * nunjuk ke binary node doang, sedangkan kita start lewat `npm run start`
 * jadi `npm`-nya juga perlu resolve ke versi yang sama, ada di folder bin
 * yang sama itu).
 *
 * Return `null` kalau versi belum terinstall / nvm belum ada, BUKAN nge-throw -
 * caller (pm2.js/node.routes.js) yang mutusin gimana nanganin "belum ada".
 */
function resolveBinDir(user, version) {
  if (!version || !isNvmInstalled(user)) return null;
  const result = shell.runAsUser(user, withNvm(`nvm which ${version}`), { silent: true });
  if (!result.ok) return null;
  const lines = result.output.trim().split('\n').filter(Boolean);
  const nodePath = lines[lines.length - 1];
  if (!nodePath || !nodePath.startsWith('/')) return null;
  return path.posix.dirname(nodePath);
}

module.exports = {
  isNvmInstalled,
  installNvm,
  listInstalled,
  installVersion,
  uninstallVersion,
  setDefault,
  resolveBinDir,
};
