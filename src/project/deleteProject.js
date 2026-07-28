const fs = require('fs');
const pm2 = require('../pm2/pm2');
const nginx = require('../nginx/nginx');
const registry = require('../registry/registry');
const dbRegistry = require('../registry/dbRegistry');
const database = require('../database/database');
const cleanup = require('../cleanup/cleanup');

/**
 * Kumpulkan apa aja yang bakal kena kalau project ini dihapus - dipakai
 * caller (menu/API) buat ditampilin ke user SEBELUM eksekusi (ringkasan
 * konfirmasi), supaya user tau persis dampaknya sebelum ketik ulang nama
 * project buat konfirmasi.
 */
function preview(project) {
  const pm2Result = pm2.listAppsIncludingUnstarted();
  const pm2App = (pm2Result.apps || []).find((a) => a.name === project.name) || null;

  let nginxFile = null;
  let nginxCheckFailed = false;
  let nginxCheckError = null;
  if (project.domain) {
    const sitesResult = nginx.listSites();
    if (sitesResult.ok) {
      const match = sitesResult.sites.find((s) => s.domain === project.domain);
      if (match) nginxFile = match.file;
    } else {
      // BUKAN "site tidak ada" - ini gagal CEK (mis. permission/error waktu
      // baca folder nginx conf). Beda kasus, jangan disamain, biar caller
      // (execute()) nggak diam-diam nganggep "aman dilewati" padahal
      // sebenernya nggak ketauan sama sekali kondisinya.
      nginxCheckFailed = true;
      nginxCheckError = sitesResult.error;
    }
  }

  const relatedDatabases = dbRegistry.listEntries().filter((e) => e.usedByProject === project.name);

  return {
    pm2App,
    nginxFile,
    nginxCheckFailed,
    nginxCheckError,
    relatedDatabases,
    folderExists: !!(project.path && fs.existsSync(project.path)),
  };
}

/**
 * Eksekusi delete. Tiap step dijalankan satu-satu dan HASILNYA DICATAT
 * SEMUA - kalau satu step gagal, lanjut ke step berikutnya (bukan berhenti
 * total), supaya nggak nyisain state "setengah kehapus" yang lebih
 * membingungkan daripada aslinya (mis. PM2 sukses dihapus tapi nginx gagal -
 * caller tetap dikasih tau nginx-nya masih ada, bukan diam-diam kelewat).
 *
 * URUTAN SENGAJA: Registry dihapus PALING TERAKHIR. Kalau step sebelumnya
 * (PM2/nginx/database/folder) ada yang gagal di tengah jalan, project MASIH
 * tercatat di registry - jadi masih bisa dicek/di-retry manual, bukan
 * "hilang" dari radar tool ini padahal PM2/nginx-nya nyatanya masih nyangkut.
 *
 * @param {object} project - entry dari registry.listProjects()
 * @param {object} opts
 * @param {boolean} [opts.deletePm2=true]
 * @param {boolean} [opts.deleteNginx=true]
 * @param {boolean} [opts.dropDatabases=false] - kalau true, database terkait
 *   BENERAN di-DROP (destruktif, hilang datanya). Kalau false tapi ada
 *   database terkait, cuma "unlink" (usedByProject dikosongkan, database &
 *   isinya TETAP ada di MySQL & dbRegistry).
 * @param {boolean} [opts.deleteFolder=false] - default false SENGAJA, folder
 *   project (source code) TIDAK dihapus kecuali eksplisit diminta.
 */
function execute(project, opts = {}) {
  const { deletePm2 = true, deleteNginx = true, dropDatabases = false, deleteFolder = false } = opts;
  const owner = project.deploy_user;
  const results = [];

  if (deletePm2) {
    const delResult = pm2.deleteApp(project.name, owner);
    if (delResult.ok) {
      const saveResult = pm2.saveStartup(owner);
      results.push({
        step: 'PM2 App',
        ok: true,
        message: saveResult.ok
          ? `App "${project.name}" dihapus dari PM2 & startup list disimpan.`
          : `App "${project.name}" dihapus dari PM2, TAPI "pm2 save" gagal (${saveResult.errorMessage}) - kalau server reboot SEBELUM di-save manual, PM2 bisa nyoba nyalain lagi app yang sudah dihapus foldernya (resurrect gagal, tapi tetap perlu "pm2 save" manual sesudah ini).`,
      });
    } else {
      // Kemungkinan besar app ini memang sudah nggak ada di PM2 (mis. sudah
      // di-stop/delete manual sebelumnya) - bukan berarti proses delete
      // project ini gagal total, jadi tetap lanjut ke step lain.
      results.push({
        step: 'PM2 App',
        ok: false,
        message: `${delResult.errorMessage} (kemungkinan app memang sudah tidak ada di PM2 - dilewati, lanjut ke step berikutnya)`,
      });
    }
  }

  if (deleteNginx) {
    if (!project.domain) {
      results.push({ step: 'Nginx Site', ok: true, message: 'Project ini tidak punya domain terdaftar - dilewati.' });
    } else {
      const sitesResult = nginx.listSites();
      if (!sitesResult.ok) {
        // Gagal CEK (bukan gagal karena site emang nggak ada) - JANGAN
        // dilaporkan sebagai "dilewati aman", tapi sebagai step gagal, biar
        // user tau site nginx-nya belum tentu kehapus dan perlu dicek manual.
        results.push({
          step: 'Nginx Site',
          ok: false,
          message: `Gagal mengecek daftar site nginx (${sitesResult.error || 'unknown error'}) - site untuk domain "${project.domain}" TIDAK dipastikan terhapus, cek & hapus manual kalau perlu.`,
        });
      } else {
        const match = sitesResult.sites.find((s) => s.domain === project.domain);
        if (!match) {
          results.push({
            step: 'Nginx Site',
            ok: true,
            message: `Site nginx untuk domain "${project.domain}" tidak ditemukan (mungkin sudah dihapus manual sebelumnya) - dilewati.`,
          });
        } else {
          const delResult = nginx.deleteSite(match.file);
          results.push({
            step: 'Nginx Site',
            ok: delResult.ok,
            message: delResult.ok ? `Site "${project.domain}" dihapus & nginx sudah di-reload.` : delResult.errorMessage,
          });
        }
      }
    }
  }

  const relatedDatabases = dbRegistry.listEntries().filter((e) => e.usedByProject === project.name);
  for (const db of relatedDatabases) {
    if (dropDatabases) {
      const dropResult = database.dropDatabase(db.dbName, db.dbUser);
      results.push({
        step: `Database "${db.dbName}"`,
        ok: dropResult.ok,
        message: dropResult.ok ? 'Database & user MySQL-nya dihapus permanen.' : dropResult.errorMessage,
      });
      if (dropResult.ok) {
        try {
          dbRegistry.removeEntry(db.dbName);
        } catch (err) {
          // Database MySQL-nya sudah beneran kehapus di titik ini - kalau
          // removeEntry dari dbRegistry gagal, jangan laporkan step ini
          // sebagai gagal (bisa bikin user coba drop lagi & nabrak "database
          // sudah tidak ada"). Catat sebagai warning terpisah.
          results.push({ step: `Database "${db.dbName}" (cleanup registry)`, ok: false, message: `Database sudah terhapus, tapi gagal dibersihkan dari dbRegistry: ${err.message}` });
        }
      }
    } else {
      try {
        dbRegistry.upsertEntry({ ...db, usedByProject: null });
        results.push({
          step: `Database "${db.dbName}" (unlink)`,
          ok: true,
          message: 'Database TIDAK dihapus - cuma dilepas keterkaitannya dari project ini, datanya tetap ada di MySQL & dbRegistry.',
        });
      } catch (err) {
        results.push({ step: `Database "${db.dbName}" (unlink)`, ok: false, message: err.message });
      }
    }
  }

  if (deleteFolder) {
    if (!project.path) {
      results.push({ step: 'Folder Project', ok: true, message: 'Project ini tidak punya path terdaftar - dilewati.' });
    } else {
      const delResult = cleanup.deleteProjectFolder(owner, project.path);
      results.push({
        step: 'Folder Project',
        ok: delResult.ok,
        message: delResult.ok ? `Folder "${project.path}" dihapus.` : delResult.errorMessage,
      });
    }
  }

  try {
    registry.removeProject(project.name);
    results.push({ step: 'Registry', ok: true, message: 'Project dihapus dari registry.' });
  } catch (err) {
    results.push({ step: 'Registry', ok: false, message: err.message });
  }

  const allOk = results.every((r) => r.ok);
  return { ok: allOk, results };
}

module.exports = { preview, execute };
