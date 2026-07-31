/**
 * Daftar metadata per-action yang di-expose lewat API. Ini BUKAN command
 * runner - API gak pernah nerima raw shell command dari client. Tiap route
 * di src/api/routes/ manggil 1 function spesifik dari src/pm2, src/git, dst
 * dengan parameter yang sudah divalidasi. File ini cuma nentuin, per-action:
 *
 * - confirmRequired: kalau true, request WAJIB nyertain `confirm: true` di
 *   body - buat aksi destruktif/susah di-undo (drop database, hapus project,
 *   restore backup timpa data lama, dll). Klien (bot/app) tetap harus nanya
 *   konfirmasi ke user sebelum ngirim confirm:true - ini cuma lapisan
 *   terakhir di server-side, bukan pengganti konfirmasi di UI.
 * - auditLevel: 'read' (baca doang, low-risk) atau 'write' (ngubah state
 *   server) - dipakai audit.js buat nentuin detail apa yang dicatat.
 *
 * Nambah action baru = nambah entry di sini + bikin route-nya. Kalau action
 * gak ada di daftar ini, dianggap TIDAK di-expose (default deny).
 */
const POLICY = {
  'monitor.getStatus': { confirmRequired: false, auditLevel: 'read' },
  // Gabungan status registry+nginx+ssl per domain - read-only murni, gak
  // ngubah state apapun, dipakai buat layar "Domain" & live-check pas ngetik.
  'domains.list': { confirmRequired: false, auditLevel: 'read' },
  'domains.status': { confirmRequired: false, auditLevel: 'read' },
  // Deploy project BARU - bukan overwrite/hapus apapun yang sudah ada
  // (safety.preDeployCheck di dalam deployNextJs sudah nolak kalau nama/
  // port/domain bentrok sama project lain), jadi gak perlu confirm eksplisit.
  'deploy.deployNextJs': { confirmRequired: false, auditLevel: 'write' },
  // Retry cuma bisa jalan dari job yang UDAH ADA dan statusnya "failed" -
  // gak bisa dipakai buat bikin/timpa apapun yang baru, jadi gak perlu confirm.
  'deploy.retry': { confirmRequired: false, auditLevel: 'write' },
  'jobs.get': { confirmRequired: false, auditLevel: 'read' },
  'jobs.list': { confirmRequired: false, auditLevel: 'read' },
  // Terbitin sertifikat SSL - dibatasi cuma buat domain yang udah terdaftar
  // di registry (lihat ssl.routes.js), jadi gak bisa disalahgunakan buat
  // domain sembarang & gak perlu confirm eksplisit.
  'ssl.issue': { confirmRequired: false, auditLevel: 'write' },
  // Cek sisa masa berlaku sertifikat - read-only.
  'ssl.checkExpiry': { confirmRequired: false, auditLevel: 'read' },
  // certbot renew otomatis skip yang belum waktunya - aman tanpa confirm.
  'ssl.renewAll': { confirmRequired: false, auditLevel: 'write' },
  // Bikin database + user baru - ini nambah, bukan nimpa/hapus apapun yang
  // udah ada (createDatabase pakai CREATE ... IF NOT EXISTS), jadi gak perlu
  // confirm. TETAP auditLevel 'write' karena ngubah state MySQL.
  'database.create': { confirmRequired: false, auditLevel: 'write' },
  // Baca doang - list database, list/describe/count/preview tabel. Gak
  // ngubah state apapun, jadi gak perlu confirm.
  'database.list': { confirmRequired: false, auditLevel: 'read' },
  'database.listTables': { confirmRequired: false, auditLevel: 'read' },
  'database.describeTable': { confirmRequired: false, auditLevel: 'read' },
  'database.countRows': { confirmRequired: false, auditLevel: 'read' },
  'database.previewTable': { confirmRequired: false, auditLevel: 'read' },
  // Reset password nimpa kredensial LAMA (gak bisa di-undo, password lama
  // hilang permanen begitu di-ALTER USER) - tapi TIDAK bikin confirmRequired
  // karena efeknya cuma ganti password (bukan hapus data), operator yang
  // ngirim request ini dianggap emang punya niat itu.
  'database.resetPassword': { confirmRequired: false, auditLevel: 'write' },
  // DROP DATABASE - destruktif total & GAK ADA UNDO (data hilang permanen).
  // WAJIB confirm:true di body, ini action pertama yang beneran menegakkan
  // confirmRequired di level route (lihat database.routes.js).
  'database.drop': { confirmRequired: true, auditLevel: 'write' },
  // Set/lepas field usedByProject di dbRegistry (bukan MySQL) - cuma metadata
  // "database ini dipakai project mana", dipakai fitur "Hapus Project" biar
  // tau database mana yang harus ikut di-drop. Nge-link/unlink doang, gak
  // ngubah data MySQL apapun - gak perlu confirm.
  'database.link': { confirmRequired: false, auditLevel: 'write' },
  // Tes koneksi MySQL (root & kredensial spesifik) - read-only, gak ngubah
  // state apapun.
  'database.testConnection': { confirmRequired: false, auditLevel: 'read' },
  'database.testCredentials': { confirmRequired: false, auditLevel: 'read' },

  // --- PM2 ---
  // List/detail/logs - baca doang, gak perlu confirm.
  'pm2.list': { confirmRequired: false, auditLevel: 'read' },
  'pm2.detail': { confirmRequired: false, auditLevel: 'read' },
  'pm2.logs': { confirmRequired: false, auditLevel: 'read' },
  // Start/stop/restart - ngubah state proses tapi gampang di-undo (start
  // lagi/restart lagi), jadi gak perlu confirm eksplisit.
  'pm2.start': { confirmRequired: false, auditLevel: 'write' },
  'pm2.stop': { confirmRequired: false, auditLevel: 'write' },
  'pm2.restart': { confirmRequired: false, auditLevel: 'write' },
  // Delete - app langsung down & entry PM2 hilang (perlu full start command
  // buat balikin). WAJIB confirm:true.
  'pm2.delete': { confirmRequired: true, auditLevel: 'write' },
  'pm2.saveStartup': { confirmRequired: false, auditLevel: 'write' },

  // --- Nginx ---
  'nginx.listSites': { confirmRequired: false, auditLevel: 'read' },
  'nginx.viewSite': { confirmRequired: false, auditLevel: 'read' },
  'nginx.testConfig': { confirmRequired: false, auditLevel: 'read' },
  // Bikin site baru - add-only, domain sudah dicek konflik lewat
  // safety.checkDomain() di route, jadi gak perlu confirm eksplisit.
  'nginx.createSite': { confirmRequired: false, auditLevel: 'write' },
  // Reload aman (nginx.reload() test config dulu, auto-batal kalau invalid).
  'nginx.reload': { confirmRequired: false, auditLevel: 'write' },
  // Hapus site - domain langsung unreachable. WAJIB confirm:true.
  'nginx.deleteSite': { confirmRequired: true, auditLevel: 'write' },
  // Baca error log nginx per-domain (tail file, read-only) - gak ngubah
  // state apapun, gak perlu confirm.
  'nginx.errorLog': { confirmRequired: false, auditLevel: 'read' },

  // --- Git ---
  'git.status': { confirmRequired: false, auditLevel: 'read' },
  'git.listBranches': { confirmRequired: false, auditLevel: 'read' },
  'git.log': { confirmRequired: false, auditLevel: 'read' },
  // Pull nambah commit baru dari remote - gampang "diundo" (checkout balik/
  // reset), gak perlu confirm.
  'git.pull': { confirmRequired: false, auditLevel: 'write' },
  // Checkout ganti branch aktif project - bisa bikin behavior app berubah
  // drastis kalau branch salah, tapi gampang checkout balik, gak perlu confirm.
  'git.checkout': { confirmRequired: false, auditLevel: 'write' },
  'git.stash': { confirmRequired: false, auditLevel: 'write' },
  // Destruktif (buang perubahan lokal + reset paksa ke remote) - dipakai
  // sebagai jalan keluar pas pull() DAN stash() sama-sama nolak karena ada
  // unmerged files/conflict yang gak terselesaikan.
  'git.forceSyncToRemote': { confirmRequired: true, auditLevel: 'write' },
  // Ganti remote URL origin (kredensial GitHub per-project) - gampang
  // diulang/gak ngerusak data lain kalau salah pilih akun, jadi gak perlu
  // confirm eksplisit.
  'git.updateCredentials': { confirmRequired: false, auditLevel: 'write' },

  // --- Configuration (tool ini sendiri, bukan config per-project) ---
  'config.view': { confirmRequired: false, auditLevel: 'read' },
  // Bisa nimpa deploy_user/path sistem yang dipakai HAMPIR SEMUA fitur lain
  // (nginx, ssl, database, cleanup) - salah isi bisa bikin semuanya rusak
  // sekaligus. WAJIB confirm:true.
  'config.update': { confirmRequired: true, auditLevel: 'write' },
  'config.github.list': { confirmRequired: false, auditLevel: 'read' },
  // Nambah akun baru - gak nimpa/hapus apapun yang lain (label sama = replace
  // yang emang disengaja user), gak perlu confirm.
  'config.github.add': { confirmRequired: false, auditLevel: 'write' },
  // Hapus akun tersimpan - project yang masih pakai token ini di remote URL
  // TIDAK ikut ke-update, jadi WAJIB confirm biar user sadar konsekuensinya.
  'config.github.remove': { confirmRequired: true, auditLevel: 'write' },

  // --- Doctor / self-check (sudoers, command availability) ---
  'doctor.checkPermissions': { confirmRequired: false, auditLevel: 'read' },

  // --- Build/Install manual (job-based, di luar alur Deploy) ---
  // Bisa nimpa node_modules/.next hasil build lama, tapi ini "rebuild",
  // bukan "hapus data" - gak perlu confirm eksplisit (gampang diulang kalau
  // hasil rebuild-nya jelek, project asli/database tidak tersentuh).
  'build.runManual': { confirmRequired: false, auditLevel: 'write' },
  // `prisma db seed` BISA insert/timpa data tergantung isi seed script-nya
  // sendiri (di luar kendali tool ini) - tapi karena ini fitur yang memang
  // sengaja dipanggil manual oleh operator yang paham isi seed-nya, gak
  // dipaksa confirmRequired (beda dari database.drop yang jelas-jelas
  // destruktif tanpa syarat).
  'build.runSeed': { confirmRequired: false, auditLevel: 'write' },

  // --- Backup & Restore ---
  'backup.list': { confirmRequired: false, auditLevel: 'read' },
  // Backup nambah file baru doang, gak nimpa/hapus apapun yang ada.
  'backup.project': { confirmRequired: false, auditLevel: 'write' },
  'backup.database': { confirmRequired: false, auditLevel: 'write' },
  // Restore MENIMPA isi folder project / database tujuan dengan isi backup -
  // data lama yang belum di-backup ulang hilang permanen. WAJIB confirm:true.
  'backup.restoreProject': { confirmRequired: true, auditLevel: 'write' },
  'backup.restoreDatabase': { confirmRequired: true, auditLevel: 'write' },
  // Hapus file backup - permanen, gak ada undo. WAJIB confirm:true.
  'backup.delete': { confirmRequired: true, auditLevel: 'write' },
  // Scan file .sql/.sql.gz lepas di folder umum VPS - read-only.
  'backup.scanSqlFiles': { confirmRequired: false, auditLevel: 'read' },
  // Import SQL dari luar bisa nimpa data existing di database tujuan
  // (tergantung isi file-nya) - WAJIB confirm:true, sama pola dengan restore.
  'backup.importSql': { confirmRequired: true, auditLevel: 'write' },
  // Unduh file backup yang sudah ada ke device client - read-only, gak
  // ngubah state apapun di server.
  'backup.download': { confirmRequired: false, auditLevel: 'read' },
  // Upload file .sql/.sql.gz dari HP ke backup_dir - nambah file baru
  // (bukan nimpa/hapus apapun yang ada), jadi gak perlu confirm. Import-nya
  // sendiri tetap lewat backup.importSql yang WAJIB confirm.
  'backup.uploadSql': { confirmRequired: false, auditLevel: 'write' },
  // Terminal bebas dari HP - lihat peringatan di system.routes.js.
  'system.exec': { confirmRequired: false, auditLevel: 'write' },

  // --- Security (read-only) ---
  'security.checkFirewall': { confirmRequired: false, auditLevel: 'read' },
  'security.listOpenPorts': { confirmRequired: false, auditLevel: 'read' },
  'security.checkFail2ban': { confirmRequired: false, auditLevel: 'read' },
  'security.checkSshConfig': { confirmRequired: false, auditLevel: 'read' },

  // --- Scanner (read-only) ---
  'scanner.pm2Apps': { confirmRequired: false, auditLevel: 'read' },
  'scanner.ports': { confirmRequired: false, auditLevel: 'read' },
  'scanner.apiHealth': { confirmRequired: false, auditLevel: 'read' },
  'scanner.full': { confirmRequired: false, auditLevel: 'read' },

  // --- Cleanup ---
  'cleanup.scanUserCache': { confirmRequired: false, auditLevel: 'read' },
  'cleanup.scanProjectCaches': { confirmRequired: false, auditLevel: 'read' },
  // Hapus cache/file (rm -rf) - permanen, gak ada undo. WAJIB confirm:true.
  'cleanup.deletePath': { confirmRequired: true, auditLevel: 'write' },

  // --- Project (env & delete) ---
  'project.readEnv': { confirmRequired: false, auditLevel: 'read' },
  // Timpa isi .env lama - gak bisa di-undo (isi lama hilang begitu ditulis),
  // tapi bukan aksi "hapus resource" (app/database/project) jadi gak
  // disamain sama pola destruktif lain; tetap WAJIB confirm:true karena efek
  // salah ketik .env bisa langsung bikin app down/salah konfigurasi.
  'project.writeEnv': { confirmRequired: true, auditLevel: 'write' },
  // Preview dampak delete project - read-only, cuma ngumpulin info (PM2 app,
  // nginx site, database terkait, folder) buat ditampilin SEBELUM eksekusi.
  'project.deletePreview': { confirmRequired: false, auditLevel: 'read' },
  // Hapus project (PM2 + nginx + database opsional + folder opsional +
  // registry). DESTRUKTIF TOTAL & gak ada undo (apalagi kalau dropDatabases/
  // deleteFolder true) - WAJIB confirm:true.
  'project.delete': { confirmRequired: true, auditLevel: 'write' },
};

function getPolicy(action) {
  return POLICY[action] || null;
}

function isExposed(action) {
  return Boolean(POLICY[action]);
}

module.exports = { POLICY, getPolicy, isExposed };
