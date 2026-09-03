const https = require('https');
const config = require('../config/config');

function postJson(hostname, path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 10000 },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: chunks }));
      },
    );
    req.on('error', (err) => resolve({ ok: false, errorMessage: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, errorMessage: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

async function sendDiscord(webhookUrl, content) {
  try {
    const url = new URL(webhookUrl);
    return await postJson(url.hostname, url.pathname + url.search, { content });
  } catch (err) {
    return { ok: false, errorMessage: err.message };
  }
}

async function sendTelegram(botToken, chatId, text) {
  return postJson('api.telegram.org', `/bot${botToken}/sendMessage`, { chat_id: chatId, text });
}

/**
 * Kirim notifikasi ke channel yang dikonfigurasi (Discord dan/atau Telegram -
 * boleh dua-duanya sekaligus, boleh gak ada satupun yang keisi, dalam hal itu
 * fungsi ini no-op diam-diam - dipanggil dari deployWorker.js SETELAH setiap
 * job selesai, jadi gak boleh melempar error yang bisa ganggu job itu sendiri).
 */
async function notify(message) {
  const cfg = config.loadConfig();
  const results = [];
  if (cfg.discord_webhook_url) {
    results.push(await sendDiscord(cfg.discord_webhook_url, message));
  }
  if (cfg.telegram_bot_token && cfg.telegram_chat_id) {
    results.push(await sendTelegram(cfg.telegram_bot_token, cfg.telegram_chat_id, message));
  }
  return results;
}

module.exports = { notify, sendDiscord, sendTelegram };
