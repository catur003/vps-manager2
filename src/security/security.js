const shell = require('../utils/shell');

// Semua command di file ini FIXED (gak ada argumen dari request/user sama
// sekali) - beda dari cleanup.js/git.js/backup.js yang emang nerima input
// eksternal. Tetap dipindah ke shell.runArgs() (execFileSync, argv terpisah,
// TANPA shell/pipe) demi konsistensi & defense-in-depth di seluruh codebase,
// bukan karena ada celah injection nyata di sini.

function checkFirewall() {
  const ufwResult = shell.runArgs('sudo', ['ufw', 'status'], { silent: true });
  if (ufwResult.ok && ufwResult.output && !ufwResult.output.includes('command not found')) {
    return { ok: true, tool: 'ufw', output: ufwResult.output };
  }
  const firewalldResult = shell.runArgs('sudo', ['firewall-cmd', '--state'], { silent: true });
  if (firewalldResult.ok) {
    return { ok: true, tool: 'firewalld', output: firewalldResult.output };
  }
  return { ok: false, errorMessage: 'Tidak terdeteksi ufw atau firewalld terinstall/aktif.' };
}

/**
 * Parse 1 baris output `ss -tlnp` secara robust - TIDAK mengandalkan index
 * kolom tetap (parts[3], parts[6], dst), karena jumlah kolom bisa beda
 * tergantung ada/tidaknya kolom "Netid" di awal (beda versi `ss`/OS). Kalau
 * dipaksa pakai index tetap, gampang salah ambil kolom dan hasilnya jadi
 * "-"/kosong padahal datanya sebenarnya ada - itu akar masalah kenapa port
 * scanner kelihatan nggak informatif sebelumnya.
 *
 * Strategi: cari token yang match pola "alamat:port" (ada 2 di tiap baris -
 * Local lalu Peer, ambil yang PERTAMA), dan cari token yang diawali "users:"
 * buat kolom Process (posisinya di mana saja tetap ketemu).
 */
function parseSsLine(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);

  const addrPortTokens = tokens.filter((t) => /:(\d+|\*)$/.test(t));
  const localAddress = addrPortTokens[0] || null;
  const portMatch = localAddress ? localAddress.match(/:(\d+)$/) : null;

  const processTokenIdx = tokens.findIndex((t) => t.startsWith('users:'));
  const rawProcess = processTokenIdx !== -1 ? tokens.slice(processTokenIdx).join(' ') : null;

  // rawProcess contoh: users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))
  // Ambil entry PERTAMA aja sebagai representasi (biasanya semua entry di
  // socket yang sama adalah proses yang sama, cuma beda pid worker/thread).
  let processName = null;
  let pid = null;
  if (rawProcess) {
    const match = rawProcess.match(/\(\("([^"]+)",pid=(\d+)/);
    if (match) {
      processName = match[1];
      pid = match[2];
    }
  }

  return {
    port: portMatch ? portMatch[1] : '-',
    address: localAddress || '-',
    processName,
    pid,
  };
}

/**
 * FIXED (Fase 5, defense-in-depth): sebelumnya `sudo ss -tlnp | tail -n +2`
 * (shell pipe). Sekarang cuma `ss -tlnp` argv-based, baris header dibuang di
 * JS (slice(1)) - hasil akhirnya identik, tapi gak ada shell/pipe yang
 * dilibatkan sama sekali.
 */
function listOpenPorts() {
  const result = shell.runArgs('sudo', ['ss', '-tlnp'], { silent: true });
  if (!result.ok) return { ok: false, ports: [], error: result.errorMessage };

  const lines = result.output.split('\n').filter(Boolean).slice(1); // buang header
  const ports = lines.map((line) => {
    const parsed = parseSsLine(line);
    return {
      port: parsed.port,
      address: parsed.address,
      processName: parsed.processName, // null kalau nggak kebaca (biasanya kurang privilege)
      pid: parsed.pid,
      // Teks siap-tampil untuk caller lama (Security Manager) - SELALU ada
      // isinya, nggak pernah undefined/kosong.
      process: parsed.processName
        ? `${parsed.processName} (pid ${parsed.pid})`
        : 'tidak diketahui (perlu akses sudo untuk lihat nama proses)',
    };
  });

  return { ok: true, ports };
}

/**
 * FIXED: sebelumnya errorMessage selalu digeneralisir jadi "tidak
 * terinstall/tidak aktif" walaupun penyebab aslinya adalah sudoers belum
 * mengizinkan `fail2ban-client` (bukan soal install sama sekali) - bikin
 * user salah diagnosa & coba "sudo apt install fail2ban" padahal itu sudah
 * terinstall. Sekarang dibedakan lewat isi stderr, sama seperti pola di
 * doctor.js checkSudoAccess().
 */
function checkFail2ban() {
  const result = shell.runArgs('sudo', ['fail2ban-client', 'status'], { silent: true });
  if (result.ok) {
    return { ok: true, installed: true, output: result.output };
  }

  const stderrText = (result.errorMessage || '').trim();
  const needsPermission = /password is required|not allowed to execute|a terminal is required/i.test(stderrText);

  if (needsPermission) {
    return {
      ok: false,
      installed: null,
      permissionIssue: true,
      errorMessage: 'Sudo belum mengizinkan "fail2ban-client status" - bukan berarti fail2ban belum terinstall. Jalankan ulang scripts/setup-sudoers.sh.',
    };
  }

  return {
    ok: false,
    installed: false,
    permissionIssue: false,
    errorMessage: 'fail2ban tidak terinstall/tidak aktif.',
  };
}

/**
 * Cek setting SSH yang paling krusial buat keamanan (read-only, nggak diubah).
 *
 * FIXED (Fase 5, defense-in-depth): `grep -E` sekarang argv-based (regex
 * pattern & path dikirim sebagai argv terpisah, bukan disisipkan ke satu
 * string command).
 */
function checkSshConfig() {
  const result = shell.runArgs('sudo', ['grep', '-E', '^(PermitRootLogin|PasswordAuthentication|Port)\\s', '/etc/ssh/sshd_config'], { silent: true });
  if (!result.ok || !result.output) {
    return { ok: false, errorMessage: 'Gagal membaca /etc/ssh/sshd_config atau setting masih default (tidak eksplisit di-set).' };
  }

  const settings = {};
  result.output.split('\n').forEach((line) => {
    const [key, value] = line.trim().split(/\s+/);
    if (key) settings[key] = value;
  });

  return { ok: true, settings };
}

module.exports = { checkFirewall, listOpenPorts, checkFail2ban, checkSshConfig };
