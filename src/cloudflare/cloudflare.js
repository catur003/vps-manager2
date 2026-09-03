const https = require('https');
const config = require('../config/config');

/**
 * Client minimal buat Cloudflare API v4 - CUMA 3 operasi yang dibutuhkan
 * (cari zone ID dari nama domain, purge cache, toggle security level), gak
 * perlu library terpisah (`cloudflare` npm package) buat sesempit ini.
 */
function requestCloudflare(method, path, token, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request(
      { hostname: 'api.cloudflare.com', path: `/client/v4${path}`, method, headers, timeout: 15000 },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed;
          try { parsed = JSON.parse(chunks); } catch { parsed = null; }
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed?.success) {
            resolve({ ok: true, result: parsed.result });
          } else {
            const errMsg = parsed?.errors?.map((e) => e.message).join(', ') || `HTTP ${res.statusCode}`;
            resolve({ ok: false, errorMessage: errMsg });
          }
        });
      },
    );
    req.on('error', (err) => resolve({ ok: false, errorMessage: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, errorMessage: 'Timeout menghubungi Cloudflare API.' }); });
    if (data) req.write(data);
    req.end();
  });
}

function getToken() {
  const cfg = config.loadConfig();
  return cfg.cloudflare_api_token || null;
}

/**
 * Cari Zone ID dari nama domain (mis. "zenlab.id") - dibutuhkan SEMUA
 * operasi lain di bawah, Cloudflare API-nya sendiri gak nerima nama domain
 * langsung, harus lewat Zone ID. `domain` di sini WAJIB apex domain
 * (root zone di Cloudflare, mis. "zenlab.id"), BUKAN subdomain
 * (mis. "anime.zenlab.id" harus dicari pakai "zenlab.id").
 */
async function findZoneId(apexDomain) {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Cloudflare API Token belum diset di Settings.' };
  const result = await requestCloudflare('GET', `/zones?name=${encodeURIComponent(apexDomain)}`, token);
  if (!result.ok) return result;
  if (!result.result || result.result.length === 0) {
    return { ok: false, errorMessage: `Zone "${apexDomain}" tidak ditemukan di akun Cloudflare token ini.` };
  }
  return { ok: true, zoneId: result.result[0].id };
}

async function purgeCache(apexDomain) {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Cloudflare API Token belum diset di Settings.' };
  const zoneResult = await findZoneId(apexDomain);
  if (!zoneResult.ok) return zoneResult;
  return requestCloudflare('POST', `/zones/${zoneResult.zoneId}/purge_cache`, token, { purge_everything: true });
}

/**
 * Toggle Under Attack Mode (security_level = 'under_attack' vs 'medium' -
 * "medium" dipilih sebagai default balik, bukan "essentially_off", karena
 * itu level default rekomendasi Cloudflare buat kondisi normal).
 */
async function setUnderAttackMode(apexDomain, enabled) {
  const token = getToken();
  if (!token) return { ok: false, errorMessage: 'Cloudflare API Token belum diset di Settings.' };
  const zoneResult = await findZoneId(apexDomain);
  if (!zoneResult.ok) return zoneResult;
  return requestCloudflare('PATCH', `/zones/${zoneResult.zoneId}/settings/security_level`, token, {
    value: enabled ? 'under_attack' : 'medium',
  });
}

module.exports = { findZoneId, purgeCache, setUnderAttackMode, getToken };
