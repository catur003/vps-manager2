#!/usr/bin/env node

const inquirer = require('inquirer');
const { showMainMenu } = require('../src/menu/mainMenu');
const authStore = require('../src/auth/authStore');
const config = require('../src/config/config');

function setupUrl() {
  const cfg = config.loadConfig();
  if (cfg.api?.public_url) return String(cfg.api.public_url).replace(/\/$/, '') + '/setup.html';
  return `https://IP_VPS:${cfg.api?.public_port || 4001}/setup.html`;
}

function printSetupStatus() {
  const state = authStore.status();
  console.log('');
  console.log('Status autentikasi VPS Manager');
  console.log(`Administrator : ${state.initialized ? 'sudah dibuat' : 'belum dibuat'}`);
  console.log(`Setup token   : ${state.setupEnabled ? (state.setupExpired ? 'kedaluwarsa' : 'aktif') : '-'}`);
  if (state.setupExpiresAt) console.log(`Berlaku sampai: ${state.setupExpiresAt}`);
  if (!state.initialized) console.log(`Setup URL     : ${setupUrl()}`);
}

async function resetAdminPassword() {
  const first = await inquirer.prompt([{
    type: 'password',
    name: 'password',
    message: 'Password admin baru (minimal 12 karakter):',
    mask: '*',
  }, {
    type: 'password',
    name: 'confirm',
    message: 'Ulangi password baru:',
    mask: '*',
  }]);
  if (first.password !== first.confirm) throw new Error('Konfirmasi password tidak sama.');
  const result = authStore.resetPassword(first.password);
  console.log(`Password admin "${result.username}" berhasil diubah. Semua session lama aktif sudah dikeluarkan.`);
}

async function main() {
  const [command, subcommand] = process.argv.slice(2);
  if (command === 'setup-status') {
    printSetupStatus();
    return;
  }
  if (command === 'setup-token') {
    if (subcommand && subcommand !== 'regenerate') throw new Error('Gunakan: node bin/vps-manager.js setup-token regenerate');
    const result = authStore.generateSetupToken();
    console.log('');
    console.log('Setup token baru (hanya ditampilkan sekarang):');
    console.log(result.token);
    console.log('');
    console.log(`Setup URL     : ${setupUrl()}`);
    console.log(`Berlaku sampai: ${result.expiresAt}`);
    console.log('Token lama otomatis tidak berlaku.');
    return;
  }
  if (command === 'admin' && subcommand === 'reset-password') {
    await resetAdminPassword();
    return;
  }
  if (command) {
    throw new Error('Command tidak dikenal. Gunakan setup-status, setup-token regenerate, atau admin reset-password dari bin/vps-manager.js.');
  }
  await showMainMenu();
}

main().catch((err) => {
  console.error('Terjadi error:', err.message);
  process.exit(1);
});
