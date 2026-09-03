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
/**
 * FIX TOTAL (2026-08-17, ketauan bareng Zen lewat cek manual `ls -la` di
 * VPS): parsing SEBELUMNYA cuma nangkep pola `vX.Y.Z` dari OUTPUT TEKS
 * `nvm ls`, TANPA cek apakah baris itu punya marker `(-> N/A)` - yang
 * artinya nvm SENDIRI udah bilang "alias ini nunjuk ke versi yang GAK
 * BENERAN keinstall". Semua alias LTS bawaan nvm (`lts/argon`,
 * `lts/boron`, dst - INI SELALU ADA di nvm siapapun, hardcoded, gak
 * peduli beneran install apa nggak) ikut ke-parse sebagai "versi
 * terinstall" gara-gara ini. Konfirmasi manual: `ls -la
 * ~/.nvm/versions/node/` di VPS Zen KOSONG TOTAL, sementara `nvm ls`
 * nampilin 11 baris versi - SEMUA-nya alias kosong.
 *
 * Fix: `versions` sekarang GROUND TRUTH langsung dari isi folder
 * `$NVM_DIR/versions/node/` (`ls` biasa, satu-satunya sumber yang gak bisa
 * bohong soal "beneran ada folder instalasinya apa nggak"), BUKAN dari
 * regex ke teks `nvm ls`. `nvm ls` TETAP dipakai buat cari tau
 * default/current, TAPI hasilnya di-cross-check ke daftar ground-truth itu
 * dulu - default/current yang nunjuk ke versi HANTU (gak ada di ground
 * truth) dianggap gak valid, bukan dipaksa ditampilin.
 */
function listInstalled(user) {
  if (!isNvmInstalled(user)) {
    return { ok: false, errorMessage: `nvm belum terinstall untuk user "${user}".`, versions: [], nvmInstalled: false };
  }

  const dirResult = shell.runAsUser(user, withNvm('ls "$NVM_DIR/versions/node" 2>/dev/null'), { silent: true });
  if (!dirResult.ok) return { ok: false, errorMessage: dirResult.errorMessage, versions: [], nvmInstalled: true };

  const versions = dirResult.output
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => /^v\d+\.\d+\.\d+$/.test(s));

  let defaultVersion = null;
  let currentVersion = null;
  const lsResult = shell.runAsUser(user, withNvm('nvm ls --no-colors'), { silent: true });
  if (lsResult.ok) {
    lsResult.output.split('\n').forEach((rawLine) => {
      const line = rawLine.trim();
      if (line.includes('N/A')) return; // alias TANPA folder instalasi beneran - skip total
      const match = line.match(/v\d+\.\d+\.\d+/);
      if (!match) return;
      const v = match[0];
      if (!versions.includes(v)) return; // jaga-jaga tambahan - cuma percaya versi yang KEBUKTI ada foldernya
      if (line.startsWith('->')) currentVersion = v;
      if (line.startsWith('default')) defaultVersion = v;
    });
  }

  // Per-versi: npm version (baca langsung dari folder bin versi itu, TANPA
  // perlu `nvm use` - jadi gak nge-switch versi aktif cuma buat nge-cek) +
  // tanggal instalasi (mtime folder versi - proxy real, bukan field metadata
  // resmi nvm karena nvm sendiri gak nyimpen tanggal install).
  const versionDetails = versions.map((v) => {
    const npmPath = `$NVM_DIR/versions/node/${v}/bin/npm`;
    const npmVerResult = shell.runAsUser(user, withNvm(`[ -x "${npmPath}" ] && "${npmPath}" -v`), { silent: true });
    const mtimeResult = shell.runAsUser(user, `stat -c %y "$HOME/.nvm/versions/node/${v}" 2>/dev/null`, { silent: true });
    return {
      version: v,
      npmVersion: npmVerResult.ok ? npmVerResult.output.trim() : null,
      installedAt: mtimeResult.ok ? mtimeResult.output.trim().slice(0, 16) : null,
    };
  });

  return { ok: true, nvmInstalled: true, versions, versionDetails, defaultVersion, currentVersion };
}

/**
 * Info tambahan buat kartu ringkasan Node Manager - global packages (`npm
 * list -g`) dan versi npm yang lagi aktif. Semua REAL (dihitung langsung),
 * bukan angka statis.
 */
function getGlobalInfo(user) {
  const npmVerResult = shell.runAsUser(user, 'npm -v', { silent: true });
  const listResult = shell.runAsUser(user, 'npm list -g --depth=0 --json 2>/dev/null', { silent: true });
  let packages = [];
  if (listResult.ok) {
    try {
      const parsed = JSON.parse(listResult.output);
      packages = Object.entries(parsed.dependencies || {}).map(([name, info]) => ({ name, version: info.version }));
    } catch { /* npm kadang nyelipin warning non-JSON ke stdout - biarin packages kosong drpd crash */ }
  }

  const nodePathResult = shell.runAsUser(user, 'which node', { silent: true });
  const npmPathResult = shell.runAsUser(user, 'which npm', { silent: true });
  const globalPathResult = shell.runAsUser(user, 'npm root -g', { silent: true });
  const shellResult = shell.runArgs('getent', ['passwd', user], { silent: true });
  const shellPath = shellResult.ok ? (shellResult.output.split(':')[6] || null) : null;

  return {
    ok: true,
    npmVersion: npmVerResult.ok ? npmVerResult.output.trim() : null,
    packages,
    platform: process.platform,
    arch: process.arch,
    nodePath: nodePathResult.ok ? nodePathResult.output.trim() : null,
    npmPath: npmPathResult.ok ? npmPathResult.output.trim() : null,
    globalPath: globalPathResult.ok ? globalPathResult.output.trim() : null,
    user,
    shell: shellPath,
  };
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

/**
 * Daftar versi yang BOLEH diinstall - dipanggil buat isi dropdown "Install
 * versi baru" (sebelumnya user WAJIB ngetik manual versi persis, gampang
 * typo/gak tau versi apa aja yang valid). `nvm ls-remote --lts` query
 * REAL ke release index Node.js (bukan hardcode daftar statis yang bisa
 * basi), diringkas ke versi LTS MAYOR terbaru tiap baris "vX.Y.Z" biar
 * dropdown-nya gak isinya ratusan patch version.
 */
function listAvailableVersions(user) {
  if (!isNvmInstalled(user)) {
    const installResult = installNvm(user);
    if (!installResult.ok) return { ok: false, errorMessage: installResult.errorMessage, versions: [] };
  }
  const result = shell.runAsUser(user, withNvm('nvm ls-remote --lts --no-colors'), { timeoutMs: 30000, silent: true });
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage, versions: [] };

  const lines = result.output.split('\n').filter((l) => /^\s*v\d+\.\d+\.\d+/.test(l));
  const latestPerMajor = new Map();
  for (const line of lines) {
    const match = line.match(/v(\d+)\.(\d+)\.(\d+)/);
    if (!match) continue;
    const [full, major] = [match[0], match[1]];
    latestPerMajor.set(major, full); // list-nya urut lama->baru, jadi entry TERAKHIR per major = versi terbaru
  }
  const versions = [...latestPerMajor.values()].reverse(); // major terbaru duluan
  return { ok: true, versions: ['lts/*', 'node', ...versions] };
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
/**
 * BUG FIX (laporan Zen: klik hapus, versi gak ilang dari list - termasuk
 * versi yang JELAS bukan default/aktif kayak v4.9.1, jadi dugaan
 * "nvm nolak hapus versi aktif" GUGUR, itu bukan akar masalahnya beneran).
 * Sebelumnya fungsi ini cuma PERCAYA exit code `nvm uninstall` doang - kalau
 * exit-nya 0 tapi versi-nya ternyata TETEP ada (banyak kemungkinan: symlink
 * aneh, permission, versi itu sebenernya bukan bikinan nvm asli), app gak
 * pernah tau, cuma keliatan "gak ngefek".
 *
 * Sekarang di-VERIFIKASI BENERAN: abis `nvm uninstall`, cek ulang `nvm ls`
 * - kalau versi itu MASIH ada di daftar, dianggap GAGAL (walau exit code
 * command sebelumnya 0), dan output MENTAH `nvm uninstall` diikutsertakan
 * di pesan error biar kebaca APA KATA NVM SEBENERNYA, bukan nebak lagi.
 */
function uninstallVersion(user, version) {
  if (!isValidVersionInput(version)) {
    return { ok: false, errorMessage: 'Format versi tidak valid.' };
  }

  // REVISI (laporan Zen: pesan asli "N/A: version is not installed" abis
  // dikasih diagnostik) - `nvm deactivate` yang ditambah sebelumnya (teori
  // "nolak hapus versi aktif", UDAH KEBUKTI SALAH karena v4.9.1 juga kena
  // padahal jelas bukan default/aktif) DICABUT - dicurigai `nvm deactivate`
  // di command chain YANG SAMA justru ngerusak state resolve versi nvm
  // buat `nvm uninstall` sesudahnya (makanya nvm gak nemu versinya sama
  // sekali, dibalikin sebagai "N/A" bukan pesan "masih aktif").
  const uninstallResult = shell.runAsUser(user, withNvm(`nvm uninstall ${version} 2>&1`));

  const verify = listInstalled(user);
  const stillThere = verify.ok && verify.versions.includes(version.startsWith('v') ? version : `v${version}`);

  if (stillThere) {
    return {
      ok: false,
      errorMessage:
        `Versi ${version} MASIH ada setelah dicoba dihapus (dicek ulang lewat "nvm ls", bukan nebak dari exit code doang). ` +
        `Output "nvm uninstall": ${uninstallResult.output || uninstallResult.errorMessage || '(kosong)'}`,
    };
  }

  return uninstallResult;
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
  listAvailableVersions,
  getGlobalInfo,
  installVersion,
  uninstallVersion,
  setDefault,
  resolveBinDir,
};
