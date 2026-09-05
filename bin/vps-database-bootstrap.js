#!/usr/bin/env node

const database = require('../src/database/database');
const config = require('../src/config/config');

if (typeof process.getuid === 'function' && process.getuid() !== 0) {
  console.error('Setup database awal wajib dijalankan sebagai root.');
  process.exit(1);
}

const preservePlatformConfig = process.env.BOOTSTRAP_PRESERVE_PLATFORM_CONFIG === '1';
if (!preservePlatformConfig) {
  const cfg = config.loadConfig();
  cfg.deploy_user = process.env.BOOTSTRAP_DEPLOY_USER || cfg.deploy_user;
  cfg.default_folder = process.env.BOOTSTRAP_APPS_DIR || cfg.default_folder;
  cfg.docker_projects_dir = process.env.BOOTSTRAP_DOCKER_DIR || cfg.docker_projects_dir || '/opt/docker';
  cfg.certbot_webroot = process.env.BOOTSTRAP_CERTBOT_DIR || cfg.certbot_webroot;
  cfg.nginx_conf_dir = process.env.BOOTSTRAP_NGINX_CONF_DIR || cfg.nginx_conf_dir;
  cfg.nginx_binary = process.env.BOOTSTRAP_NGINX_BINARY || cfg.nginx_binary;
  cfg.nginx_log_dir = process.env.BOOTSTRAP_NGINX_LOG_DIR || cfg.nginx_log_dir;
  config.saveConfig(cfg);
}

const result = database.setupRootDatabase();
if (!result.ok) {
  if (result.needsCredentials) {
    if (process.env.BOOTSTRAP_DB_CREDENTIALS_PROVIDED === '1') {
      console.error(result.errorMessage || 'Kredensial admin database tidak valid.');
    }
    process.exit(20);
  }
  console.error(result.errorMessage || 'Setup database gagal.');
  process.exit(1);
}

console.log(result.message);
