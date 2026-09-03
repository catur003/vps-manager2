const crypto = require('crypto');
const shell = require('../utils/shell');
const config = require('../config/config');

const KEY_LINE_REGEX = /^(ssh-(rsa|ed25519|ecdsa)|ecdsa-sha2-\S+)\s+[A-Za-z0-9+/=]+(\s+.*)?$/;

function authorizedKeysPath(user) {
  return `/home/${user}/.ssh/authorized_keys`;
}

function targetUser() {
  return config.loadConfig().deploy_user;
}

function fingerprintOf(line) {
  const parts = line.trim().split(/\s+/);
  const keyBody = parts[1] || '';
  return crypto.createHash('sha256').update(keyBody).digest('base64').slice(0, 24);
}

/**
 * Baca `authorized_keys` user deploy lewat `sudo cat` (bukan langsung fs.readFile
 * dari proses ini - proses API bisa jalan sebagai user beda dari deploy_user
 * di setup multi-user, sama seperti pola di seluruh codebase ini yang selalu
 * lewat `sudo` buat operasi lintas-user).
 */
function listKeys() {
  const user = targetUser();
  const path = authorizedKeysPath(user);
  const result = shell.runArgs('sudo', ['test', '-f', path]);
  if (!result.ok) return { ok: true, keys: [], user, path, note: 'Belum ada authorized_keys - user ini belum punya SSH key manapun.' };

  const catResult = shell.runArgs('sudo', ['cat', path], { silent: true });
  if (!catResult.ok) return { ok: false, errorMessage: catResult.errorMessage };

  const keys = catResult.output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        type: parts[0],
        comment: parts.slice(2).join(' ') || '(tanpa komentar)',
        fingerprint: fingerprintOf(line),
        raw: line,
      };
    });

  return { ok: true, keys, user, path };
}

/**
 * Tambah public key baru ke authorized_keys. Validasi format ketat
 * (KEY_LINE_REGEX) sebelum ditulis - mencegah baris rusak yang bisa bikin
 * SSH daemon nolak SEMUA key di file itu.
 */
function addKey(publicKeyLine) {
  const line = (publicKeyLine || '').trim();
  if (!KEY_LINE_REGEX.test(line)) {
    return { ok: false, errorMessage: 'Format public key tidak valid. Harus diawali ssh-rsa/ssh-ed25519/ecdsa-sha2-... diikuti base64 key.' };
  }
  const user = targetUser();
  const path = authorizedKeysPath(user);

  const sshDir = `/home/${user}/.ssh`;
  shell.runArgs('sudo', ['mkdir', '-p', sshDir]);
  shell.runArgs('sudo', ['chmod', '700', sshDir]);
  shell.runArgs('sudo', ['chown', `${user}:${user}`, sshDir]);

  const appendResult = shell.runArgs('sudo', ['tee', '-a', path], { input: `${line}\n`, silent: true });
  if (!appendResult.ok) return { ok: false, errorMessage: appendResult.errorMessage };

  shell.runArgs('sudo', ['chmod', '600', path]);
  shell.runArgs('sudo', ['chown', `${user}:${user}`, path]);
  return { ok: true };
}

/**
 * Hapus 1 key berdasarkan fingerprint (bukan index - lebih aman dari race
 * condition kalau ada 2 request bersamaan). Tulis ulang seluruh file minus
 * baris yang cocok, lewat file sementara + `sudo cp` (atomic-ish, gak pernah
 * nulis file kosong ke tengah kalau command gagal di tengah jalan).
 */
function removeKey(fingerprint) {
  const user = targetUser();
  const path = authorizedKeysPath(user);
  const current = listKeys();
  if (!current.ok) return current;

  const remaining = current.keys.filter((k) => k.fingerprint !== fingerprint);
  if (remaining.length === current.keys.length) {
    return { ok: false, errorMessage: 'Key dengan fingerprint tersebut tidak ditemukan.' };
  }

  const content = remaining.map((k) => k.raw).join('\n') + (remaining.length ? '\n' : '');
  const writeResult = shell.runArgs('sudo', ['tee', path], { input: content, silent: true });
  if (!writeResult.ok) return { ok: false, errorMessage: writeResult.errorMessage };

  return { ok: true };
}

/**
 * Generate keypair baru (ed25519) buat dipakai deploy_user connect KE server
 * lain (mis. clone repo private via SSH) - beda dari authorized_keys di atas
 * (yang ngontrol siapa yang boleh masuk KE server ini).
 */
function generateKeypair(comment) {
  const user = targetUser();
  const keyPath = `/home/${user}/.ssh/id_ed25519_${Date.now()}`;
  const safeComment = (comment || `vps-manager-${Date.now()}`).replace(/[^a-zA-Z0-9._@-]/g, '');

  const result = shell.runArgs('sudo', ['-u', user, 'ssh-keygen', '-t', 'ed25519', '-f', keyPath, '-N', '', '-C', safeComment]);
  if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

  const pubResult = shell.runArgs('sudo', ['cat', `${keyPath}.pub`], { silent: true });
  if (!pubResult.ok) return { ok: false, errorMessage: pubResult.errorMessage };

  return { ok: true, privateKeyPath: keyPath, publicKey: pubResult.output };
}

module.exports = { listKeys, addKey, removeKey, generateKeypair };
