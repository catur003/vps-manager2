// UI helpers - KHUSUS CLI interaktif, pakai inquirer (prompt) dan/atau
// logger (cetak ke terminal). Ini yang TIDAK bisa langsung dipakai ulang
// dari bot Telegram/web nanti - kalau mau versi bot/web, functionnya perlu
// dibuatin varian baru yang ambil input dari luar (bukan inquirer.prompt)
// dan return data (bukan logger.card ke terminal).

const inquirer = require('inquirer');
const logger = require('../utils/logger');
const registry = require('../registry/registry');
const config = require('../config/config');
const monitor = require('../monitor/monitor');

/**
 * Prompt umum "pilih project dari registry, atau input path manual" -
 * dipakai di banyak menu (Git, PM2, Backup, dll).
 */
async function pickProjectPath() {
  const projects = registry.listProjects();
  const cfg = config.loadConfig();

  if (projects.length > 0) {
    const { choice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'choice',
        message: 'Pilih project:',
        choices: [...projects.map((p) => ({ name: p.name, value: p })), { name: '(Input path manual)', value: 'manual' }],
      },
    ]);
    if (choice !== 'manual') {
      return { path: choice.path, deployUser: choice.deploy_user || cfg.deploy_user, projectName: choice.name };
    }
  }

  const { manualPath, manualUser } = await inquirer.prompt([
    { type: 'input', name: 'manualPath', message: 'Path folder project:' },
    { type: 'input', name: 'manualUser', message: 'Deploy user:', default: cfg.deploy_user },
  ]);
  return { path: manualPath, deployUser: manualUser, projectName: null };
}

/**
 * Tampilin card info disk (dipakai Server Monitor & Cleanup menu).
 */
function diskCard(title) {
  const disk = monitor.getDisk();
  if (!disk) {
    logger.warn('Gagal membaca info disk.');
    return null;
  }
  logger.card(
    title,
    [`Terpakai: ${disk.used} / ${disk.total} (${disk.percent}%)`, `Tersedia: ${disk.available}`],
    { color: disk.percent >= 90 ? 'red' : disk.percent >= 75 ? 'yellow' : 'green' }
  );
  return disk;
}

module.exports = {
  pickProjectPath,
  diskCard,
};
