const config = require('../config/config');
const monitor = require('../monitor/monitor');
const pm2 = require('../pm2/pm2');
const docker = require('../docker/docker');
const security = require('../security/security');
const database = require('../database/database');
const tools = require('../tools/tools');
const filemanager = require('../filemanager/filemanager');
const registry = require('../registry/registry');

/**
 * Endpoint/key/model SEPENUHNYA custom dari Configuration (bukan hardcode ke
 * satu provider) - user pakai Dahono/GLM tapi format request/response
 * OpenAI-compatible (chat/completions + tools/function-calling), jadi
 * provider apapun yang ngikutin format itu (OpenAI asli, banyak provider
 * OSS-compatible lain) otomatis jalan tanpa ubah kode.
 */
function aiConfig() {
  const cfg = config.loadConfig();
  return {
    baseUrl: (cfg.ai_base_url || '').replace(/\/+$/, ''),
    apiKey: cfg.ai_api_key || '',
    model: cfg.ai_model || '',
    modelFilter: cfg.ai_model_filter || '',
  };
}

async function listModels() {
  const { baseUrl, apiKey, modelFilter } = aiConfig();
  if (!baseUrl) return { ok: false, errorMessage: 'ai_base_url belum diset di Configuration.' };

  const res = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  }).catch((err) => ({ networkError: err }));
  if (res.networkError) return { ok: false, errorMessage: `Gagal konek ke ${baseUrl}: ${res.networkError.message}` };
  if (!res.ok) return { ok: false, errorMessage: `Provider balas HTTP ${res.status}: ${await res.text().catch(() => '')}` };

  const json = await res.json().catch(() => null);
  if (!json) return { ok: false, errorMessage: 'Response /models bukan JSON valid.' };

  // Provider "OpenAI-compatible" gak semua nurut bentuk `{data:[{id}]}` yang
  // sama persis - sebagian (termasuk beberapa proxy/self-hosted) balikin
  // array polos `[{id}]` atau `[...]` isinya string langsung. Ini akar bug
  // "filter model kayak gak jalan" yang sebenernya: parsing-nya nemu 0 item
  // SEBELUM sempet difilter, jadi kelihatannya kayak filter yang salah
  // padahal daftar model mentahnya aja udah kosong.
  let rawList;
  if (Array.isArray(json)) rawList = json;
  else if (Array.isArray(json.data)) rawList = json.data;
  else if (Array.isArray(json.models)) rawList = json.models;
  else rawList = [];

  const allModels = rawList.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  if (!allModels.length) {
    return { ok: false, errorMessage: `Provider merespons OK tapi daftar model kosong/format gak dikenali. Response mentah: ${JSON.stringify(json).slice(0, 300)}` };
  }
  const filtered = modelFilter
    ? allModels.filter((m) => m.toLowerCase().includes(modelFilter.toLowerCase()))
    : allModels;
  return { ok: true, models: filtered, total: allModels.length };
}

/**
 * Daftar tool yang boleh dipanggil AI. `sideEffect: 'read'` DIEKSEKUSI
 * OTOMATIS server-side (sesuai instruksi user: "baca semuanya gada
 * batasan") - `sideEffect: 'write'` TIDAK PERNAH auto-eksekusi, selalu
 * dibalikin ke frontend sebagai pendingAction buat approval manual dulu
 * (popup modal "Izinkan?"), baru dieksekusi lewat confirmAction() di bawah.
 */
const TOOL_DEFS = [
  { name: 'get_system_status', sideEffect: 'read', description: 'Ambil status CPU/RAM/disk/uptime server.', parameters: { type: 'object', properties: {} },
    run: () => monitor.getStatus() },
  { name: 'list_pm2_apps', sideEffect: 'read', description: 'List semua app PM2 beserta status/port/RAM/CPU.', parameters: { type: 'object', properties: {} },
    run: () => pm2.listAppsIncludingUnstarted() },
  { name: 'get_pm2_logs', sideEffect: 'read', description: 'Ambil log terakhir 1 app PM2.', parameters: { type: 'object', properties: { name: { type: 'string' }, lines: { type: 'number' } }, required: ['name'] },
    run: ({ name, lines }) => { const owner = registry.findProject(name)?.deploy_user || config.loadConfig().deploy_user; return pm2.logs(name, owner, lines || 50); } },
  { name: 'list_docker_containers', sideEffect: 'read', description: 'List semua Docker container.', parameters: { type: 'object', properties: {} },
    run: () => docker.listContainers() },
  { name: 'check_security', sideEffect: 'read', description: 'Cek firewall, open ports, fail2ban, dan konfigurasi SSH.', parameters: { type: 'object', properties: {} },
    run: () => ({ firewall: security.checkFirewall(), ports: security.listOpenPorts(), fail2ban: security.checkFail2ban(), ssh: security.checkSshConfig() }) },
  { name: 'list_databases', sideEffect: 'read', description: 'List semua database MySQL di server.', parameters: { type: 'object', properties: {} },
    run: () => database.listDatabases() },
  { name: 'list_projects', sideEffect: 'read', description: 'List semua project yang terdaftar di registry (domain, owner, path, dsb).', parameters: { type: 'object', properties: {} },
    run: () => ({ ok: true, projects: registry.listProjects() }) },
  { name: 'list_tools_status', sideEffect: 'read', description: 'Cek tool mana yang sudah/belum terinstall di server (mysql, redis, certbot, dst).', parameters: { type: 'object', properties: {} },
    run: () => ({ ok: true, tools: tools.detectTools() }) },
  { name: 'read_file', sideEffect: 'read', description: 'Baca isi 1 file text di server (maks 5MB).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path }) => filemanager.readFile(path) },
  { name: 'list_directory', sideEffect: 'read', description: 'List isi 1 folder di server.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path }) => filemanager.listDir(path) },

  { name: 'restart_pm2_app', sideEffect: 'write', description: 'Restart 1 app PM2.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: ({ name }) => { const owner = registry.findProject(name)?.deploy_user || config.loadConfig().deploy_user; return pm2.restart(name, owner); } },
  { name: 'stop_pm2_app', sideEffect: 'write', description: 'Stop 1 app PM2.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: ({ name }) => { const owner = registry.findProject(name)?.deploy_user || config.loadConfig().deploy_user; return pm2.stop(name, owner); } },
  { name: 'restart_docker_container', sideEffect: 'write', description: 'Restart 1 Docker container.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: ({ name }) => docker.restart(name) },
  { name: 'install_tool', sideEffect: 'write', description: 'Install 1 tool via apt-get (mysql, redis, certbot, nginx, ufw, fail2ban, git, unzip, htop, ffmpeg, docker).', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: ({ key }) => tools.installTool(key) },
  { name: 'write_file', sideEffect: 'write', description: 'Tulis/timpa isi 1 file text di server.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    run: ({ path, content }) => filemanager.writeFile(path, content) },
  { name: 'delete_file', sideEffect: 'write', description: 'Hapus 1 file/folder di server secara permanen.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: ({ path }) => filemanager.deleteEntry(path) },
];

function toOpenAiTools() {
  return TOOL_DEFS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function findTool(name) {
  return TOOL_DEFS.find((t) => t.name === name) || null;
}

async function callProvider(messages) {
  const { baseUrl, apiKey, model } = aiConfig();
  if (!baseUrl) return { ok: false, errorMessage: 'ai_base_url belum diset di Configuration > AI Assistant.' };
  if (!model) return { ok: false, errorMessage: 'ai_model belum dipilih di Configuration > AI Assistant.' };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, messages, tools: toOpenAiTools(), tool_choice: 'auto' }),
  }).catch((err) => ({ networkError: err }));
  if (res.networkError) return { ok: false, errorMessage: `Gagal konek ke provider AI: ${res.networkError.message}` };
  if (!res.ok) return { ok: false, errorMessage: `Provider AI balas HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}` };

  const json = await res.json().catch(() => null);
  const choice = json?.choices?.[0];
  if (!choice) return { ok: false, errorMessage: 'Response provider AI gak sesuai format OpenAI (choices kosong).' };
  return { ok: true, message: choice.message };
}

const MAX_TOOL_ROUNDS = 6;

/**
 * Loop utama: kirim messages ke provider, kalau provider minta panggil tool
 * READ -> eksekusi otomatis, append hasilnya, panggil provider lagi (loop).
 * Kalau provider minta tool WRITE -> STOP, balikin `pendingAction` ke
 * caller (route) buat ditampilin sebagai modal approval - TIDAK dieksekusi
 * di sini sama sekali.
 */
async function runChat(messages) {
  let working = [...messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callProvider(working);
    if (!result.ok) return { ok: false, errorMessage: result.errorMessage };

    const msg = result.message;
    working.push(msg);

    if (!msg.tool_calls || !msg.tool_calls.length) {
      return { ok: true, messages: working, reply: msg.content, done: true };
    }

    for (const call of msg.tool_calls) {
      const tool = findTool(call.function.name);
      if (!tool) {
        working.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: false, errorMessage: `Tool "${call.function.name}" tidak dikenal.` }) });
        continue;
      }
      if (tool.sideEffect === 'write') {
        return {
          ok: true,
          done: false,
          messages: working,
          pendingAction: { toolCallId: call.id, name: tool.name, description: tool.description, args: safeParseArgs(call.function.arguments) },
        };
      }
      let args = safeParseArgs(call.function.arguments);
      let toolResult;
      try { toolResult = await tool.run(args); } catch (err) { toolResult = { ok: false, errorMessage: err.message }; }
      working.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(toolResult).slice(0, 8000) });
    }
  }

  return { ok: false, errorMessage: `Terlalu banyak tool-call berturut-turut (>${MAX_TOOL_ROUNDS}) - dihentikan biar gak infinite loop.` };
}

function safeParseArgs(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

/**
 * Dipanggil setelah user klik "Izinkan" di modal - eksekusi 1 write-tool
 * yang tadi di-pending, append hasilnya ke messages, lanjut loop chat lagi
 * (siapa tau provider mau lanjut ngomong atau minta tool lain).
 */
async function confirmAction(messages, toolCallId, toolName, args) {
  const tool = findTool(toolName);
  if (!tool) return { ok: false, errorMessage: `Tool "${toolName}" tidak dikenal.` };

  let toolResult;
  try { toolResult = await tool.run(args); } catch (err) { toolResult = { ok: false, errorMessage: err.message }; }

  const working = [...messages, { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult).slice(0, 8000) }];
  return runChat(working);
}

module.exports = { listModels, runChat, confirmAction, TOOL_DEFS };
