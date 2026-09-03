const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('../utils/safeFile');
const monitor = require('./monitor');
const pm2 = require('../pm2/pm2');
const notify = require('../notify/notify');
const logger = require('../utils/logger');

const STATE_PATH = path.join(__dirname, '..', '..', 'data', 'alert-state.json');
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // cek tiap 5 menit
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // gak spam notif yang sama < 6 jam
const DISK_THRESHOLD_PERCENT = 85;
// Restart bertambah >= N kali dalam SATU interval cek (5 menit) dianggap
// crash-loop, bukan cuma "kadang restart" - restart_time PM2 itu KUMULATIF
// sejak app pertama kali start, jadi yang dibandingkan adalah SELISIHnya
// dengan angka yang tercatat di cek sebelumnya, bukan angka mentahnya.
const PM2_RESTART_DELTA_THRESHOLD = 3;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    return { disk: {}, pm2: {} };
  }
}

function saveState(state) {
  atomicWriteJSON(STATE_PATH, state, 0o600);
}

function cooldownPassed(lastAlertAt) {
  return !lastAlertAt || Date.now() - lastAlertAt > ALERT_COOLDOWN_MS;
}

async function checkDisk(state) {
  const disk = monitor.getDisk();
  const agg = disk && disk.aggregate;
  if (!agg || typeof agg.percent !== 'number') return;

  if (agg.percent >= DISK_THRESHOLD_PERCENT) {
    if (cooldownPassed(state.disk.lastAlertAt)) {
      await notify.notify(
        `⚠️ Disk server sudah ${agg.percent}% terpakai (${agg.used} dari ${agg.total}). Cek & bersihkan sebelum penuh.`,
      );
      state.disk.lastAlertAt = Date.now();
    }
  } else {
    // Reset supaya kalau naik lagi ke atas threshold nanti, alert lagi
    // (bukan nunggu cooldown 6 jam habis dari alert lama yang udah gak relevan).
    state.disk.lastAlertAt = null;
  }
}

async function checkPm2CrashLoop(state) {
  const result = pm2.listApps();
  if (!result.ok) return;

  for (const app of result.apps) {
    const key = `${app.owner}:${app.name}`;
    const prev = state.pm2[key] || { lastRestartCount: app.restartCount, lastAlertAt: null };
    const delta = app.restartCount - prev.lastRestartCount;

    if (delta >= PM2_RESTART_DELTA_THRESHOLD && cooldownPassed(prev.lastAlertAt)) {
      await notify.notify(
        `⚠️ App "${app.name}" (user ${app.owner}) kelihatan crash-loop - restart ${delta}x dalam 5 menit terakhir (total ${app.restartCount}x). Cek log-nya.`,
      );
      prev.lastAlertAt = Date.now();
    }

    prev.lastRestartCount = app.restartCount;
    state.pm2[key] = prev;
  }
}

async function runCheck() {
  const state = loadState();
  try {
    await checkDisk(state);
    await checkPm2CrashLoop(state);
    saveState(state);
  } catch (err) {
    logger.error(`[alerting] Gagal jalanin health check: ${err.message}`);
  }
}

function scheduleAlerting() {
  setInterval(runCheck, CHECK_INTERVAL_MS);
  // Cek sekali langsung pas startup juga, gak perlu nunggu 5 menit pertama.
  runCheck();
}

module.exports = { scheduleAlerting, runCheck };
