const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const logger = require('../utils/logger');
const { apiKeyAuth } = require('./middleware/auth');
const jobStore = require('./jobs/jobStore');
const monitorRoutes = require('./routes/monitor.routes');
const deployRoutes = require('./routes/deploy.routes');
const jobsRoutes = require('./routes/jobs.routes');
const sslRoutes = require('./routes/ssl.routes');
const databaseRoutes = require('./routes/database.routes');
const pm2Routes = require('./routes/pm2.routes');
const nginxRoutes = require('./routes/nginx.routes');
const gitRoutes = require('./routes/git.routes');
const backupRoutes = require('./routes/backup.routes');
const securityRoutes = require('./routes/security.routes');
const scannerRoutes = require('./routes/scanner.routes');
const cleanupRoutes = require('./routes/cleanup.routes');
const projectRoutes = require('./routes/project.routes');
const configRoutes = require('./routes/config.routes');
const doctorRoutes = require('./routes/doctor.routes');
const buildRoutes = require('./routes/build.routes');
const systemRoutes = require('./routes/system.routes');
const domainsRoutes = require('./routes/domains.routes');
const nodeRoutes = require('./routes/node.routes');
const dockerRoutes = require('./routes/docker.routes');
const dockerComposeRoutes = require('./routes/dockerCompose.routes');
const toolsRoutes = require('./routes/tools.routes');
const sshkeysRoutes = require('./routes/sshkeys.routes');
const filemanagerRoutes = require('./routes/filemanager.routes');
const aiRoutes = require('./routes/ai.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const cronRoutes = require('./routes/cron.routes');
const webhookRoutes = require('./routes/webhook.routes');
const cloudflareRoutes = require('./routes/cloudflare.routes');
const redisRoutes = require('./routes/redis.routes');
const postgresRoutes = require('./routes/postgres.routes');
const authRoutes = require('./routes/auth.routes');
const config = require('../config/config');
const ssl = require('../ssl/ssl');
const notify = require('../notify/notify');
const alerting = require('../monitor/alerting');
const bandwidth = require('../monitor/bandwidth');

const SSL_RENEW_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // cek 1x/hari - certbot sendiri cuma beneran renew kalau <30 hari lagi, jadi aman dicek sesering ini

/**
 * Auto-renew SSL - dikontrol lewat toggle `ssl_auto_renew` di Configuration/
 * dashboard (default false/off, opt-in eksplisit). `ssl.renewAll()` sendiri
 * (`certbot renew --non-interactive`) sudah aman dipanggil berkali-kali -
 * certbot cuma beneran perpanjang sertifikat yang emang mau expired, jadi
 * gak ada resiko "over-renew" walau dicek tiap hari.
 */
function scheduleSslAutoRenew() {
  setInterval(() => {
    const cfg = config.loadConfig();
    if (!cfg.ssl_auto_renew) return;
    const result = ssl.renewAll();
    if (!result.ok) {
      notify.notify(`⚠️ Auto-renew SSL gagal: ${result.errorMessage}`);
    }
  }, SSL_RENEW_CHECK_INTERVAL_MS);
}

function createServer() {
  // Job yang masih "pending"/"running" dari sebelum API ini nyala (mis. API
  // sempet crash/restart di tengah deploy) ditandain "interrupted" di sini,
  // supaya client polling gak nunggu status yang gak bakal pernah berubah.
  jobStore.reconcileInterruptedJobs();
  scheduleSslAutoRenew();
  alerting.scheduleAlerting();
  bandwidth.scheduleBandwidthSampler();

  const app = express();
  // Trust cuma koneksi dari localhost (nginx reverse proxy di depan API ini
  // - lihat scripts/setup-sudoers.sh & nginx configs, API selalu diakses
  // lewat proxy, gak pernah expose port 4001 langsung ke publik). Tanpa ini,
  // `req.ip` selalu balikin alamat nginx sendiri (127.0.0.1) buat SEMUA
  // request asli, bikin rate limiter & lockout auth.js nge-lump semua orang
  // jadi satu "IP" yang sama alih-alih per-client - salah satu bisa
  // ke-lockout gara-gara orang lain gagal login.
  app.set('trust proxy', 'loopback');

  // Defense-in-depth untuk akses langsung ke app (bukan cuma lewat nginx).
  // Dashboard masih satu file dengan inline CSS/JS, jadi keduanya sementara
  // diizinkan di CSP sampai asset dipisah ke file sendiri.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws: wss: https:; media-src 'self' blob: https:; font-src 'self' data:",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  // `verify` nyimpen body mentah SEBELUM di-parse JSON - dibutuhin buat
  // verifikasi HMAC signature webhook GitHub (webhook.routes.js), karena
  // signature-nya dihitung dari byte mentah body, bukan dari objek hasil
  // JSON.parse (urutan key/whitespace beda dikit aja bikin hash beda).
  app.use(express.json({ limit: "6mb", verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));

  // Webhook GitHub - SEBELUM apiKeyAuth, karena GitHub gak bisa kirim Bearer
  // token kita. Autentikasinya sendiri (HMAC signature) dicek di dalam
  // webhook.routes.js, bukan lewat middleware ini.
  app.use('/webhooks', webhookRoutes);

  // Landing page publik (TANPA auth) - sebelumnya buka domain root API
  // (mis. https://api.zenin.my.id/) nunjukin JSON mentah (404/401 handler
  // default), gak enak dipandang & gak informatif. `public/index.html`
  // statis, gak perlu template engine tambahan buat 1 halaman doang.
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
  });

  // Dependency browser disajikan dari paket lokal supaya CSP tetap hanya
  // mengizinkan script/style dari origin sendiri dan dashboard tidak
  // bergantung pada CDN saat membuka Terminal atau grafik.
  const nodeModulesDir = path.join(__dirname, '..', '..', 'node_modules');
  app.get('/vendor/xterm.css', (_req, res) => res.sendFile(path.join(nodeModulesDir, 'xterm', 'css', 'xterm.css')));
  app.get('/vendor/xterm.js', (_req, res) => res.sendFile(path.join(nodeModulesDir, 'xterm', 'lib', 'xterm.js')));
  app.get('/vendor/xterm-addon-fit.js', (_req, res) => res.sendFile(path.join(nodeModulesDir, 'xterm-addon-fit', 'lib', 'xterm-addon-fit.js')));
  app.get('/vendor/chart.js', (_req, res) => res.sendFile(path.join(nodeModulesDir, 'chart.js', 'dist', 'chart.umd.js')));

  // Dashboard web + asset statis lain di public/ (dashboard.html, dst).
  // HTML/CSS/JS boleh diambil sebelum auth; data dan aksi dashboard tetap
  // dilindungi session cookie HttpOnly + CSRF pada route API di bawah.
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // Setup/login/session adalah satu-satunya API publik selain health.
  // Masing-masing endpoint sensitif punya rate-limit sendiri.
  app.use('/auth', authRoutes);

  // Health check TANPA auth - buat uptime checker/load balancer, gak
  // ngasih info apapun soal server selain "API-nya nyala".
  app.get('/health', (req, res) => {
    res.json({ success: true, message: 'ok', data: { time: new Date().toISOString() } });
  });

  // Rate limit umum semua route terlindungi - bukan buat nyegah brute
  // force (key-nya 256-bit, gak feasible ditebak), tapi buat batasin
  // dampaknya kalau key SUDAH bocor (mis. laptop kecolongan) - penyerang
  // gak bisa langsung banjirin ratusan `docker run`/`rm -rf`/dsb per detik.
  // Dashboard normal (auto-refresh tiap page + polling job) jauh di bawah
  // limit ini dalam pemakaian wajar.
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Terlalu banyak request, coba lagi sebentar lagi.', code: 'RATE_LIMITED' },
  }));

  // Semua route di bawah wajib session dashboard atau Bearer API key.
  app.use(apiKeyAuth);

  app.use('/monitor', monitorRoutes);
  app.use('/deploy', deployRoutes);
  app.use('/jobs', jobsRoutes);
  app.use('/ssl', sslRoutes);
  app.use('/database', databaseRoutes);
  app.use('/pm2', pm2Routes);
  app.use('/nginx', nginxRoutes);
  app.use('/git', gitRoutes);
  app.use('/backup', backupRoutes);
  app.use('/security', securityRoutes);
  app.use('/scanner', scannerRoutes);
  app.use('/cleanup', cleanupRoutes);
  app.use('/project', projectRoutes);
  app.use('/config', configRoutes);
  app.use('/doctor', doctorRoutes);
  app.use('/project', buildRoutes);
  app.use('/system', systemRoutes);
  app.use('/domains', domainsRoutes);
  app.use('/node', nodeRoutes);
  app.use('/docker', dockerRoutes);
  app.use('/docker-compose', dockerComposeRoutes);
  app.use('/tools', toolsRoutes);
  app.use('/ssh-keys', sshkeysRoutes);
  app.use('/filemanager', filemanagerRoutes);
  app.use('/ai', aiRoutes);
  app.use('/notifications', notificationsRoutes);
  app.use('/cron', cronRoutes);
  app.use('/cloudflare', cloudflareRoutes);
  app.use('/redis', redisRoutes);
  app.use('/postgres', postgresRoutes);

  app.use((req, res) => {
    res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan.', code: 'NOT_FOUND' });
  });

  // Error handler terakhir. Detail teknis (stack trace) selalu ditulis ke
  // log server (gampang di-grep pas debug), tapi response ke client tetap
  // pesan bersih - gak bocorin internal detail ke luar.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error(`[API] Unhandled error di ${req.method} ${req.path}: ${err.stack || err.message}`);
    if (err.type === 'entity.too.large' || err.status === 413) {
      return res.status(413).json({ success: false, message: 'Payload terlalu besar (maksimal 6MB).', code: 'PAYLOAD_TOO_LARGE' });
    }
    if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
      return res.status(400).json({ success: false, message: 'Body JSON tidak valid.', code: 'INVALID_JSON' });
    }
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({
      success: false,
      message: status === 500 ? 'Terjadi kesalahan internal di server.' : 'Request tidak valid.',
      code: status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
    });
  });

  return app;
}

module.exports = { createServer };
