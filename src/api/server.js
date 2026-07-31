const express = require('express');
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

function createServer() {
  // Job yang masih "pending"/"running" dari sebelum API ini nyala (mis. API
  // sempet crash/restart di tengah deploy) ditandain "interrupted" di sini,
  // supaya client polling gak nunggu status yang gak bakal pernah berubah.
  jobStore.reconcileInterruptedJobs();

  const app = express();
  app.use(express.json());

  // Health check TANPA auth - buat uptime checker/load balancer, gak
  // ngasih info apapun soal server selain "API-nya nyala".
  app.get('/health', (req, res) => {
    res.json({ success: true, message: 'ok', data: { time: new Date().toISOString() } });
  });

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
