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
  // `verify` nyimpen body mentah SEBELUM di-parse JSON - dibutuhin buat
  // verifikasi HMAC signature webhook GitHub (webhook.routes.js), karena
  // signature-nya dihitung dari byte mentah body, bukan dari objek hasil
  // JSON.parse (urutan key/whitespace beda dikit aja bikin hash beda).
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));

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

  // Dashboard web + asset statis lain di public/ (dashboard.html, dst).
  // Ditaruh SEBELUM apiKeyAuth karena HTML/CSS/JS-nya sendiri publik -
  // otentikasi terjadi per-request lewat fetch() di sisi client (API key
  // disimpan di localStorage browser, dikirim sebagai header Authorization),
  // bukan lewat proteksi di level penyajian file statis.
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // Health check TANPA auth - buat uptime checker/load balancer, gak
  // ngasih info apapun soal server selain "API-nya nyala".
  app.get('/health', (req, res) => {
    res.json({ success: true, message: 'ok', data: { time: new Date().toISOString() } });
  });

  // Rate limit umum SEMUA route berbasis API key - bukan buat nyegah brute
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

  // Semua route di bawah ini WAJIB API key.
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
    res.status(500).json({ success: false, message: 'Terjadi kesalahan internal di server.', code: 'INTERNAL_ERROR' });
  });

  return app;
}

module.exports = { createServer };
