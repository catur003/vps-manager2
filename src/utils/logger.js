const chalk = require('chalk');
const boxen = require('boxen');

function title(text) {
  console.log(
    boxen(chalk.cyanBright.bold(text), {
      padding: { left: 2, right: 2, top: 0, bottom: 0 },
      margin: { top: 0, bottom: 1 },
      borderColor: 'cyan',
      borderStyle: 'round',
    })
  );
}

function info(text) {
  console.log(chalk.blueBright('ℹ '), text);
}

function success(text) {
  console.log(chalk.greenBright('✔ '), text);
}

function warn(text) {
  console.log(chalk.yellowBright('⚠ '), text);
}

function error(text) {
  console.log(chalk.redBright('✘ '), text);
}

function section(text) {
  console.log(
    boxen(chalk.magentaBright.bold(text), {
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      margin: { top: 1, bottom: 1 },
      borderColor: 'magenta',
      borderStyle: 'round',
    })
  );
}

/**
 * Kartu informasi kecil (dipakai buat 1 project / 1 site / 1 app biar rapi & jelas
 * dibaca satu-satu daripada tabel lebar yang kepotong di layar HP).
 */
function card(headerText, lines, options = {}) {
  const color = options.color || 'green';
  const body = [chalk.bold(headerText), ...lines.map((l) => chalk.dim(l))].join('\n');
  console.log(
    boxen(body, {
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      margin: { top: 0, bottom: 1 },
      borderColor: color,
      borderStyle: 'round',
    })
  );
}

/**
 * Box menu statis persis mockup: title, divider, list nomor. Cuma tampilan
 * (bukan interaktif) - navigasi/pemilihan tetap lewat inquirer di bawahnya.
 */
function menuBox(title, items) {
  console.log(
    boxen(chalk.bold.white(title) + '\n' + chalk.dim('─'.repeat(Math.max(title.length, 20))) + '\n' + items.join('\n'), {
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      margin: { top: 0, bottom: 1 },
      borderColor: 'cyan',
      borderStyle: 'round',
    })
  );
}

module.exports = { title, info, success, warn, error, section, card, menuBox };
