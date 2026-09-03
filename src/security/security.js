const shell = require('../utils/shell');

// Semua command di file ini FIXED (gak ada argumen dari request/user sama
// sekali) - beda dari cleanup.js/git.js/backup.js yang emang nerima input
// eksternal. Tetap dipindah ke shell.runArgs() (execFileSync, argv terpisah,
// TANPA shell/pipe) demi konsistensi & defense-in-depth di seluruh codebase,
// bukan karena ada celah injection nyata di sini.

/**
 * Parse output `ufw status` (plain, bukan `numbered`) jadi rule terstruktur
 * - dipakai UI biar nampilin daftar port kayak tabel (badge ALLOW + nama
 * port), BUKAN nge-dump teks mentah ala terminal.
 */
function parseUfwRules(output) {
  const lines = output.split('\n').slice(3); // buang "Status: active", baris kosong, header "To/Action/From"
  const rules = [];
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(/^(\d+(?:\/\w+)?)(?:\s*\(v6\))?\s+(ALLOW|DENY|LIMIT|REJECT)(?:\s+IN)?\s+(.+?)\s*$/);
    if (!match) continue;
    const [, portProto, action] = match;
    const [port, proto] = portProto.split('/');
    const key = `${port}|${proto || ''}|${action}`;
    if (seen.has(key)) continue; // v4+v6 duplikat baris - digabung jadi 1 entry
    seen.add(key);
    rules.push({ port, proto: proto || '-', action });
  }
  return rules;
}

function checkFirewall() {
  const ufwResult = shell.runArgs('sudo', ['ufw', 'status'], { silent: true });
  if (ufwResult.ok && ufwResult.output && !ufwResult.output.includes('command not found')) {
    const active = /^Status:\s*active/im.test(ufwResult.output);
    return { ok: true, tool: 'ufw', output: ufwResult.output, active, rules: active ? parseUfwRules(ufwResult.output) : [] };
  }
  const firewalldResult = shell.runArgs('sudo', ['firewall-cmd', '--state'], { silent: true });
  if (firewalldResult.ok) {
    return { ok: true, tool: 'firewalld', output: firewalldResult.output };
  }
  // FIXED: server yang gak pakai ufw/firewalld sama sekali (Oracle Cloud
  // default, banyak provider lain yang defaultnya iptables mentah tanpa
  // manager) sebelumnya SELALU dilaporin "gagal", padahal firewall-nya
  // sendiri sehat - cuma beda tool. iptables -L INPUT dipilih (bukan -S)
  // karena lebih portable antar versi iptables-legacy/nft.
  const iptablesResult = shell.runArgs('sudo', ['iptables', '-L', 'INPUT', '-n'], { silent: true });
  if (iptablesResult.ok && iptablesResult.output) {
    return { ok: true, tool: 'iptables', output: iptablesResult.output };
  }
  return { ok: false, errorMessage: 'Tidak terdeteksi ufw, firewalld, atau iptables terinstall/aktif.' };
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
/**
 * Detail per-jail (`fail2ban-client status <jail>`) - jail list dari
 * checkFail2ban() cuma nama doang, ini yang ngasih angka beneran (Currently
 * banned/Total banned/Banned IP list) buat ditampilin sebagai kartu,
 * BUKAN nge-dump teks mentah `fail2ban-client status` ala terminal.
 */
function getFail2banJailDetail(jailName) {
  const result = shell.runArgs('sudo', ['fail2ban-client', 'status', jailName], { silent: true });
  if (!result.ok) return null;

  const currentlyBanned = parseInt((result.output.match(/Currently banned:\s*(\d+)/) || [])[1] || '0', 10);
  const totalBanned = parseInt((result.output.match(/Total banned:\s*(\d+)/) || [])[1] || '0', 10);
  const bannedIpLine = (result.output.match(/Banned IP list:\s*(.*)/) || [])[1] || '';
  const bannedIps = bannedIpLine.split(/\s+/).filter(Boolean);

  return { jail: jailName, currentlyBanned, totalBanned, bannedIps };
}

function checkFail2ban() {
  const result = shell.runArgs('sudo', ['fail2ban-client', 'status'], { silent: true });
  if (result.ok) {
    const jailMatch = result.output.match(/Jail list:\s*(.*)/i);
    const jails = jailMatch ? jailMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const jailDetails = jails.map(getFail2banJailDetail).filter(Boolean);
    return { ok: true, installed: true, output: result.output, jails: jailDetails };
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

  // grep exit code 1 = "tidak ada baris yang cocok", BUKAN error - ini kondisi
  // valid kalau setting-nya masih default (dikomentari/tidak di-set eksplisit
  // di sshd_config). Cuma exit code lain (mis. 2 = sudo/file gagal dibaca)
  // yang benar-benar berarti gagal baca.
  if (!result.ok && result.exitCode === 1) {
    return {
      ok: true,
      settings: {},
      usingDefaults: true,
      note: 'PermitRootLogin/PasswordAuthentication/Port tidak di-set eksplisit di sshd_config - OpenSSH pakai default bawaan (PermitRootLogin prohibit-password, PasswordAuthentication yes, Port 22).',
    };
  }
  if (!result.ok) {
    return { ok: false, errorMessage: result.errorMessage || 'Gagal membaca /etc/ssh/sshd_config.' };
  }

  const settings = {};
  result.output.split('\n').forEach((line) => {
    const [key, value] = line.trim().split(/\s+/);
    if (key) settings[key] = value;
  });

  return { ok: true, settings, usingDefaults: false };
}

/**
 * Percobaan login SSH terakhir (real, dari /var/log/auth.log) - dipakai
 * kartu "Recent Login Attempts" biar bukan cuma "SSH aman/gak" abstrak,
 * tapi keliatan beneran ada yang nyoba brute-force apa nggak. `tail` dulu
 * (bukan baca seluruh file - auth.log bisa berjam-jam nyimpen log & besar)
 * baru di-grep pola Accepted/Failed di JS.
 */
function getRecentSshAttempts(limit = 10) {
  // grep LANGSUNG ke seluruh file (bukan `tail -n <fixed>` terus baru
  // di-grep) - auth.log di server yang lagi rame (banyak bot-scan SSH +
  // aktivitas sudo lain) bisa gampang "ngeliwatin" baris sshd relevan
  // kalau cuma ambil N baris terakhir mentah-mentah, ketauan pas testing:
  // tail -n 2000 kadang 0 hasil walau beneran ada attempt gak lama ini.
  const result = shell.runArgs('sudo', ['grep', '-E', 'sshd\\[[0-9]+\\]: (Accepted|Failed password)', '/var/log/auth.log'], { silent: true, maxBuffer: 5 * 1024 * 1024 });
  if (!result.ok) {
    // grep exit 1 = "gak ada baris cocok" (bukan error beneran) - lihat pola sama di checkSshConfig().
    if (result.exitCode === 1) return { ok: true, attempts: [] };
    return { ok: false, errorMessage: result.errorMessage, attempts: [] };
  }

  // Ubuntu 24.04 (rsyslog modern) nulis timestamp ISO 8601 di awal baris
  // (mis. "2026-09-02T12:40:49.557408+00:00 host sshd[...]: ..."), BUKAN
  // format syslog klasik "Mon DD HH:MM:SS" - regex timestamp WAJIB match
  // yang ini, kalau nggak semua baris auth.log gagal ke-parse diam-diam.
  const attempts = [];
  for (const line of result.output.split('\n')) {
    let match = line.match(/^(\S+)\s+\S+\s+sshd\[\d+\]:\s+Accepted (\w+) for (\S+) from (\S+)/);
    if (match) {
      attempts.push({ at: match[1], success: true, method: match[2], user: match[3], ip: match[4] });
      continue;
    }
    match = line.match(/^(\S+)\s+\S+\s+sshd\[\d+\]:\s+Failed password for (?:invalid user )?(\S+) from (\S+)/);
    if (match) {
      attempts.push({ at: match[1], success: false, user: match[2], ip: match[3] });
    }
  }
  return { ok: true, attempts: attempts.slice(-limit).reverse() };
}

module.exports = { checkFirewall, listOpenPorts, checkFail2ban, checkSshConfig, getRecentSshAttempts };
