#!/usr/bin/env node

const { showMainMenu } = require('../src/menu/mainMenu');

showMainMenu().catch((err) => {
  console.error('Terjadi error tak terduga:', err.message);
  process.exit(1);
});
