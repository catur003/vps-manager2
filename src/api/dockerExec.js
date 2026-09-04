const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const url = require('url');
const shell = require('../utils/shell');
const { authenticateUpgrade } = require('./middleware/auth');

const MAX_SESSIONS = 5;
const activeSessions = new Set();
const PING_INTERVAL_MS = 25 * 1000;
// Nama container Docker valid (huruf/angka/underscore/dash/titik) - sama
// pola whitelist yang dipakai project ini buat username OS
// (cleanup.routes.js USERNAME_REGEX) - defense-in-depth di ATAS sudoers
// wildcard (`docker exec -it * sh`), yang sendirian gak bisa nyaring
// karakter aneh di posisi `*`.
const CONTAINER_NAME_REGEX = /^[a-zA-Z0-9_.-]+$/;

/**
 * Terminal masuk ke DALAM container Docker (`docker exec -it <container> sh`)
 * - beda dari terminal.js (shell host biasa). Pola WebSocket-nya SENGAJA
 * disamain persis (ping/pong keepalive, auth via ?key= di query, PTY via
 * node-pty) biar konsisten & gampang dirawat bareng.
 */
function isRealContainer(name) {
  const result = shell.run(`sudo docker ps -a --format "{{.Names}}"`, { silent: true });
  if (!result.ok) return false;
  return result.output.split('\n').includes(name);
}

function attachDockerExecServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);
  wss.on('close', () => clearInterval(pingInterval));

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== '/docker-exec') return;

    if (!authenticateUpgrade(req, query.key)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (activeSessions.size >= MAX_SESSIONS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const container = query.container || '';
    if (!container || !CONTAINER_NAME_REGEX.test(container) || !isRealContainer(container)) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const requestedShell = query.shell === 'bash' ? 'bash' : 'sh';

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { container, requestedShell }));
  });

  wss.on('connection', (ws, req, { container, requestedShell }) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const proc = pty.spawn('sudo', ['docker', 'exec', '-it', container, requestedShell], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      env: process.env,
    });
    activeSessions.add(proc);

    proc.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
    });
    proc.onExit(({ exitCode }) => {
      activeSessions.delete(proc);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit', exitCode }));
      ws.close();
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'input') proc.write(msg.data);
      else if (msg.type === 'resize' && msg.cols && msg.rows) proc.resize(msg.cols, msg.rows);
    });

    ws.on('close', () => {
      activeSessions.delete(proc);
      try { proc.kill(); } catch { /* proses mungkin udah mati duluan */ }
    });
  });
}

module.exports = { attachDockerExecServer };
