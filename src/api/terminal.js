const os = require('os');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const url = require('url');
const config = require('../config/config');

const MAX_SESSIONS = 5; // batasi jumlah terminal bersamaan biar gak dipakai buat fork-bomb resource kalau key bocor
const activeSessions = new Set();

// User lain (di luar user proses API sendiri) yang boleh dipilih di dropdown
// Terminal. "ubuntu" SENGAJA ditambah eksplisit atas persetujuan user setelah
// dikasih tau tradeoff-nya: ubuntu punya sudo grup penuh + grup docker
// langsung (~root-equivalent), beda dari user proses (biasanya "catur") yang
// cuma bisa command ter-whitelist di sudoers. WAJIB whitelist eksplisit di
// sini (bukan terima `user` apa aja dari query client) - sudoers rule di
// setup-sudoers.sh juga di-scope exact ke "ubuntu" doang, bukan wildcard.
const ALLOWED_OTHER_USERS = ['ubuntu'];
const PROCESS_USER = os.userInfo().username;

/**
 * Web terminal (xterm.js di frontend <-> node-pty di sini lewat WebSocket).
 * Default jalan sebagai user proses vps-api sendiri (biasanya "catur").
 * Bisa switch ke user lain di ALLOWED_OTHER_USERS lewat query `?user=` -
 * dieksekusi via `sudo -u <user> -i`, butuh sudoers rule matching
 * (${API_USER} ALL=(ubuntu) NOPASSWD: /bin/bash) di setup-sudoers.sh.
 *
 * Autentikasi: API key dikirim lewat query string (?key=...) karena
 * WebSocket handshake dari browser gak bisa nyetel header Authorization
 * custom. Dicek SEBELUM spawn PTY apapun - koneksi ditutup langsung kalau
 * key salah/gak ada, gak ada shell yang ke-spawn sama sekali.
 */
// Keepalive - TANPA ini, koneksi yang bener-bener diem (user gak ngetik apa
// pun) gampang di-drop paksa oleh hop jaringan di tengah (NAT/firewall/ISP
// router) walau nginx-nya sendiri udah dikasih proxy_read_timeout gede -
// banyak perangkat jaringan motong koneksi TCP yang "diem total" tanpa
// peduli timeout aplikasi. Ping tiap 25 detik JAUH di bawah ambang idle-drop
// yang umum (biasanya 60-300 detik), dan ganda fungsinya: (1) bikin
// koneksi tetap "keliatan hidup" buat perangkat jaringan, (2) deteksi &
// bersihin socket yang zombie di sisi server (client mati tanpa sempat
// kirim close frame - mis. laptop tidur mendadak).
const PING_INTERVAL_MS = 25 * 1000;

function attachTerminalServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate(); // gak jawab ping SEBELUMNYA - anggap mati, bersihin
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);
  wss.on('close', () => clearInterval(pingInterval));

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== '/terminal') return; // biarin path lain (kalau ada ws lain nanti) gak kesenggol

    if (!config.verifyApiKey(query.key)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (activeSessions.size >= MAX_SESSIONS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const requestedUser = query.user || PROCESS_USER;
    if (requestedUser !== PROCESS_USER && !ALLOWED_OTHER_USERS.includes(requestedUser)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, requestedUser));
  });

  wss.on('connection', (ws, req, requestedUser) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const cfg = config.loadConfig();
    const isOtherUser = requestedUser !== PROCESS_USER;
    const shell = isOtherUser
      ? pty.spawn('sudo', ['-u', requestedUser, '-i'], {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: cfg.default_folder || process.env.HOME,
          env: process.env,
        })
      : pty.spawn('bash', [], {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd: cfg.default_folder || process.env.HOME,
          env: process.env,
        });
    activeSessions.add(shell);

    shell.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
    });
    shell.onExit(({ exitCode }) => {
      activeSessions.delete(shell);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', exitCode }));
      ws.close();
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'input') shell.write(msg.data);
      else if (msg.type === 'resize' && msg.cols && msg.rows) shell.resize(msg.cols, msg.rows);
    });

    ws.on('close', () => {
      activeSessions.delete(shell);
      try { shell.kill(); } catch { /* proses mungkin udah mati duluan */ }
    });
  });
}

module.exports = { attachTerminalServer };
