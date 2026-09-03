const shell = require('../utils/shell');

function isInstalled() {
  return shell.commandExists('redis-cli');
}

/**
 * Parse output `redis-cli info` (format `key:value` per baris, section
 * dipisah baris `# NamaSection`) jadi flat object - cukup buat kebutuhan
 * dashboard ini (gak perlu pisah per section, semua key udah unik).
 */
function parseInfo(raw) {
  const obj = {};
  raw.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf(':');
    if (idx === -1) return;
    obj[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  });
  return obj;
}

function parseKeyspace(raw) {
  // Baris format: "db0:keys=5,expires=2,avg_ttl=1200"
  const dbs = [];
  raw.split('\n').forEach((line) => {
    const trimmed = line.trim();
    const match = trimmed.match(/^db(\d+):keys=(\d+),expires=(\d+),avg_ttl=(\d+)/);
    if (match) {
      dbs.push({ db: Number(match[1]), keys: Number(match[2]), expires: Number(match[3]), avgTtl: Number(match[4]) });
    }
  });
  return dbs;
}

function parseCommandStats(raw) {
  // Baris format: "cmdstat_get:calls=6432,usec=..." - ambil command+calls doang.
  const commands = [];
  raw.split('\n').forEach((line) => {
    const match = line.trim().match(/^cmdstat_([^:]+):calls=(\d+)/);
    if (match) commands.push({ command: match[1], calls: Number(match[2]) });
  });
  return commands.sort((a, b) => b.calls - a.calls);
}

function run(args) {
  return shell.runArgs('redis-cli', args, { silent: true });
}

function getStatus() {
  if (!isInstalled()) {
    return { ok: false, notInstalled: true, errorMessage: 'Redis belum terinstall di server ini. Install dulu lewat halaman Tools / Installer.' };
  }

  const infoResult = run(['info']);
  if (!infoResult.ok) return { ok: false, errorMessage: infoResult.errorMessage || 'Gagal konek ke Redis (redis-server mungkin belum jalan).' };
  const info = parseInfo(infoResult.output);

  const keyspaceResult = run(['info', 'keyspace']);
  const keyspace = keyspaceResult.ok ? parseKeyspace(keyspaceResult.output) : [];

  const commandStatsResult = run(['info', 'commandstats']);
  const topCommands = commandStatsResult.ok ? parseCommandStats(commandStatsResult.output).slice(0, 10) : [];

  const slowlogResult = run(['slowlog', 'get', '10']);
  // Output slowlog get RESP array-of-arrays via redis-cli text mode - parsing
  // penuh butuh RESP parser, disederhanakan jadi hitung jumlah entry doang
  // (cukup buat indikator "ada slow query atau nggak" di dashboard).
  const slowlogCount = slowlogResult.ok ? (slowlogResult.output.match(/^\d+\)/gm) || []).length : 0;

  const hits = Number(info.keyspace_hits || 0);
  const misses = Number(info.keyspace_misses || 0);
  const hitRate = hits + misses > 0 ? (hits / (hits + misses)) * 100 : null;

  return {
    ok: true,
    server: {
      version: info.redis_version,
      mode: info.redis_mode,
      os: info.os,
      port: info.tcp_port,
      uptimeSeconds: Number(info.uptime_in_seconds || 0),
      uptimeDays: Number(info.uptime_in_days || 0),
      runId: info.run_id,
    },
    memory: {
      usedBytes: Number(info.used_memory || 0),
      usedHuman: info.used_memory_human,
      maxBytes: Number(info.maxmemory || 0),
      maxHuman: info.maxmemory_human,
      policy: info.maxmemory_policy,
      peakHuman: info.used_memory_peak_human,
      fragmentationRatio: Number(info.mem_fragmentation_ratio || 0),
    },
    clients: {
      connected: Number(info.connected_clients || 0),
      max: Number(info.maxclients || 0),
      blocked: Number(info.blocked_clients || 0),
    },
    stats: {
      opsPerSec: Number(info.instantaneous_ops_per_sec || 0),
      totalCommandsProcessed: Number(info.total_commands_processed || 0),
      totalConnectionsReceived: Number(info.total_connections_received || 0),
      expiredKeys: Number(info.expired_keys || 0),
      evictedKeys: Number(info.evicted_keys || 0),
      keyspaceHits: hits,
      keyspaceMisses: misses,
      hitRate,
    },
    persistence: {
      rdbLastSaveTime: Number(info.rdb_last_save_time || 0),
      rdbLastBgsaveStatus: info.rdb_last_bgsave_status,
      rdbChangesSinceLastSave: Number(info.rdb_changes_since_last_save || 0),
      aofEnabled: info.aof_enabled === '1',
      aofLastBgrewriteStatus: info.aof_last_bgrewrite_status,
      aofLastWriteStatus: info.aof_last_write_status,
    },
    replication: {
      role: info.role,
      connectedSlaves: Number(info.connected_slaves || 0),
      masterReplOffset: Number(info.master_repl_offset || 0),
    },
    keyspace,
    topCommands,
    slowlogCount,
  };
}

module.exports = { isInstalled, getStatus };
