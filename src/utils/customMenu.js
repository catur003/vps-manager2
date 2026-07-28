const chalk = require('chalk');
const boxen = require('boxen');
const readline = require('readline');

/**
 * Render menu box + terima navigasi panah LANGSUNG di box yang sama (single
 * widget). PENTING: pakai teknik "geser cursor ke atas + hapus ke bawah"
 * (ANSI \x1b[nA + \x1b[0J), BUKAN console.clear() - karena banyak SSH client
 * (terutama app Android) nggak support clear-screen penuh, yang bikin tiap
 * render numpuk ke bawah bukannya nge-replace.
 */
// Strip emoji & variation selectors sebelum ngitung panjang visual, soalnya
// emoji makan 2+ code unit di JS (.length) padahal cuma keliatan 1-2 kolom
// di terminal. Tanpa ini, padEnd() bisa ngasilin lebar highlight yang beda-beda
// antar baris (gerigi) tergantung banyaknya emoji di label.
const EMOJI_REGEX = /(\u{FE0F}|\u{200D}|\p{Extended_Pictographic}|\p{Emoji_Modifier})/gu;

function visualLength(str) {
  return str.replace(EMOJI_REGEX, '').length;
}

// HP/SSH client layar sempit (~40-50 kolom). Kalau ada baris teks yang lebih
// panjang dari lebar terminal, terminal bakal auto-wrap sendiri ke baris
// berikutnya - tapi render() cuma ngitung jumlah baris via `\n` (bukan baris
// yang KETEKAN di layar), jadi geser-cursor-ke-atas pas render() berikutnya
// jadi kurang tinggi & sisa box lama numpuk (bug numpuk kotak). Makanya teks
// panjang (hint) di-wrap manual ke beberapa baris pendek di sini dulu, biar
// jumlah baris yang dihitung selalu sama persis dengan yang tampil di layar.
function wrapText(text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visualLength(candidate) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function terminalWidth() {
  // Fallback konservatif kalau `columns` nggak kedeteksi (beberapa SSH client
  // Android nggak selalu ngasih tau); mendingan under-estimate daripada wrap.
  return (process.stdout.columns && process.stdout.columns > 10 ? process.stdout.columns : 44) - 2;
}

function showMenu(title, items) {
  return new Promise((resolve) => {
    let selected = 0;
    let lastLineCount = 0;

    function buildOutput() {
      const width = Math.max(visualLength(title), ...items.map((i) => visualLength(i.label))) + 2;
      const lines = items.map((item, idx) => {
        const text = `${item.key.padStart(2, ' ')}. ${item.label}`;
        const pad = Math.max(0, width - visualLength(text));
        if (idx === selected) {
          return chalk.inverse.bold(`❯ ${text}${' '.repeat(pad)}`);
        }
        return chalk.white(`  ${text}`);
      });
      const content =
        chalk.bold.white(title) + '\n' + chalk.dim('─'.repeat(Math.max(title.length, 20))) + '\n' + lines.join('\n');

      const boxOutput = boxen(content, {
        padding: { left: 1, right: 1, top: 0, bottom: 0 },
        margin: { top: 0, bottom: 0 },
        borderColor: 'cyan',
        borderStyle: 'round',
      });
      const legend = chalk.dim('  ⬆️⬇️  pilih   ↵ Enter   Ctrl+C keluar');
      const activeHint = items[selected].hint;
      let hintBlock = '';
      if (activeHint) {
        const wrapped = wrapText(activeHint, terminalWidth() - 4);
        hintBlock = wrapped
          .map((line, idx) => chalk.dim.italic(idx === 0 ? `  💡 ${line}` : `     ${line}`))
          .join('\n');
      }
      return hintBlock ? `${boxOutput}\n${legend}\n${hintBlock}` : `${boxOutput}\n${legend}`;
    }

    function render() {
      const output = buildOutput();
      if (lastLineCount > 0) {
        // Geser cursor ke atas sejumlah baris yang dicetak sebelumnya, lalu
        // hapus semua dari situ ke bawah, baru cetak ulang. Ini kompatibel
        // di hampir semua terminal (beda dari console.clear()).
        process.stdout.write(`\x1b[${lastLineCount}A\x1b[0J`);
      }
      process.stdout.write(output + '\n');
      lastLineCount = output.split('\n').length;
    }

    render();

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    function onKeypress(str, key) {
      if (!key) return;
      if (key.name === 'up') {
        selected = (selected - 1 + items.length) % items.length;
        render();
      } else if (key.name === 'down') {
        selected = (selected + 1) % items.length;
        render();
      } else if (key.name === 'return') {
        cleanup();
        resolve(items[selected].key);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }
    }

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      // Handoff bersih ke inquirer.prompt() yang biasa dipanggil abis ini.
      // Tanpa pause(), stdin masih "resume()"-an dari showMenu() dan bentrok
      // sama readline interface punya inquirer sendiri - di beberapa SSH
      // client (mis. Termius) ini kelihatan sebagai prompt yang ke-render
      // berkali-kali/numpuk pas inquirer.prompt() pertama kali jalan.
      process.stdin.pause();
    }

    process.stdin.on('keypress', onKeypress);
  });
}

module.exports = { showMenu };
