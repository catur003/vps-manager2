const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const shell = require('../utils/shell');
const safety = require('../safety/safety');
const cleanup = require('../cleanup/cleanup');

const SAFE_NAME = /^[a-zA-Z0-9_-]+$/;

function isValidStackName(name) {
  return typeof name === 'string' && SAFE_NAME.test(name);
}

/**
 * Deteksi framework dari isi repo yang BARU di-clone - dipakai buat milih
 * template Dockerfile/compose yang cocok tanpa user harus tau istilah
 * teknisnya. Urutan cek penting: `artisan` (Laravel) dicek duluan karena
 * project Laravel JUGA punya package.json (buat asset build/Vite), jadi
 * kalau urutan kebalik bakal salah kedeteksi sebagai "Node".
 */
function detectFramework(folderPath, deployUser) {
  const has = (rel) => shell.runAsUser(deployUser, `test -f "${folderPath}/${rel}" && echo yes || echo no`, { silent: true }).output === 'yes';
  if (has('artisan')) return 'laravel';
  if (has('package.json')) return 'node';
  return 'static';
}

/**
 * Dockerfile per-framework. SEMUANYA cuma dipakai kalau project belum punya
 * Dockerfile sendiri di root repo (lihat deployCompose()) - kalau developer
 * sudah nulis Dockerfile custom, punya mereka yang dipakai, bukan di-timpa.
 */
function dockerfileFor(framework) {
  if (framework === 'laravel') {
    // FIX (dibuktikan lewat 2x percobaan deploy real laravel/laravel yang
    // gagal): base image pihak-ketiga (richarvey/nginx-php-fpm) yang
    // tadinya dipakai TERNYATA UDAH GAK DI-MAINTAIN - semua tag termasuk
    // "latest" masih PHP 8.2, sedangkan source code Laravel versi terbaru
    // (bukan cuma composer.json-nya - kode PHP-nya sendiri) sudah pakai
    // syntax yang CUMA valid di PHP 8.3+. `--ignore-platform-reqs` cuma
    // ngakalin composer, gak bisa bikin PHP 8.2 tiba-tiba paham syntax
    // 8.3 (errornya "syntax error, unexpected token" pas parse, bukan
    // error dependency). Sekarang dibangun sendiri dari image resmi PHP
    // (php:8.3-fpm-alpine) + nginx + supervisor manual - gak gantung ke
    // image komunitas yang bisa kadaluwarsa lagi ke depannya.
    return [
      'FROM php:8.3-fpm-alpine',
      'RUN apk add --no-cache nginx supervisor bash curl git unzip libzip-dev icu-dev oniguruma-dev libpng-dev freetype-dev libjpeg-turbo-dev \\',
      ' && docker-php-ext-configure gd --with-freetype --with-jpeg \\',
      ' && docker-php-ext-install pdo_mysql mbstring exif pcntl bcmath gd intl zip \\',
      ' && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer',
      'WORKDIR /var/www/html',
      'COPY . .',
      'RUN composer install --no-dev --optimize-autoloader',
      // FIX (dibuktikan lewat tes deploy real): php-fpm di image ini jalan
      // sebagai user `www-data`, tapi `COPY . .` di atas nyalin semua file
      // dengan owner `root` (default COPY, gak ada --chown). `chmod 775`
      // doang gak cukup - www-data bukan member grup root, jadi tetep gak
      // bisa nulis. Laravel butuh nulis ke storage/ & bootstrap/cache/
      // (log, session, view cache) - tanpa `chown` ke www-data, app selalu
      // 500 TANPA log error sama sekali (Laravel gagal nulis error-nya
      // sendiri ke storage/logs, jadi error asli ke-swallow total).
      'RUN chown -R www-data:www-data storage bootstrap/cache && chmod -R 775 storage bootstrap/cache',
      'COPY docker/nginx.conf /etc/nginx/http.d/default.conf',
      'COPY docker/supervisord.conf /etc/supervisord.conf',
      'EXPOSE 80',
      'CMD ["/usr/bin/supervisord", "-c", "/etc/supervisord.conf"]',
      '',
    ].join('\n');
  }
  if (framework === 'node') {
    return [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm install',
      'COPY . .',
      'RUN npm run build || true',
      'EXPOSE 3000',
      'CMD ["npm", "start"]',
      '',
    ].join('\n');
  }
  // static
  return [
    'FROM nginx:alpine',
    'COPY . /usr/share/nginx/html',
    'EXPOSE 80',
    '',
  ].join('\n');
}

// nginx + supervisord config buat container Laravel self-built (lihat
// catatan panjang di dockerfileFor()) - 2 file ini WAJIB ada di build
// context sebelum `docker compose build` jalan, karena Dockerfile-nya
// nge-COPY keduanya.
function laravelNginxConf() {
  return [
    'server {',
    '    listen 80;',
    '    server_name _;',
    '    root /var/www/html/public;',
    '    index index.php;',
    '',
    '    location / {',
    '        try_files $uri $uri/ /index.php?$query_string;',
    '    }',
    '',
    '    location ~ \\.php$ {',
    '        fastcgi_pass 127.0.0.1:9000;',
    '        fastcgi_index index.php;',
    '        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
    '        include fastcgi_params;',
    '    }',
    '',
    '    location ~ /\\.(?!well-known).* {',
    '        deny all;',
    '    }',
    '}',
    '',
  ].join('\n');
}
function laravelSupervisordConf() {
  return [
    '[supervisord]',
    'nodaemon=true',
    '',
    '[program:php-fpm]',
    'command=php-fpm -F',
    'autostart=true',
    'autorestart=true',
    '',
    '[program:nginx]',
    'command=nginx -g "daemon off;"',
    'autostart=true',
    'autorestart=true',
    '',
  ].join('\n');
}

function internalPortFor(framework) {
  if (framework === 'node') return 3000;
  return 80; // laravel & static sama-sama nginx di dalam container
}

function generateDbPassword() {
  return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

/**
 * docker-compose.yml - app + optional MySQL + optional Redis, masing-masing
 * data servicenya di named volume TERPISAH (bukan bind-mount ke folder host)
 * biar gak ke-hapus/ke-timpa kalau container di-rebuild ulang (misal abis
 * `docker compose build` pas redeploy versi baru).
 */
function generateComposeFile({ stackName, framework, port, includeMysql, includeRedis, dbCreds }) {
  const internalPort = internalPortFor(framework);
  const lines = [
    'services:',
    '  app:',
    '    build: .',
    '    container_name: ' + stackName + '_app',
    '    ports:',
    `      - "${port}:${internalPort}"`,
    '    env_file:',
    '      - .env',
    '    restart: unless-stopped',
  ];
  if (framework === 'laravel') {
    lines.push('    volumes:', `      - ${stackName}_storage:/var/www/html/storage`);
  }
  const depends = [];
  if (includeMysql) depends.push('db');
  if (includeRedis) depends.push('redis');
  if (depends.length) lines.push('    depends_on:', ...depends.map((d) => `      - ${d}`));

  if (includeMysql) {
    lines.push(
      '  db:',
      '    image: mysql:8',
      '    container_name: ' + stackName + '_db',
      '    environment:',
      `      MYSQL_DATABASE: ${dbCreds.database}`,
      `      MYSQL_USER: ${dbCreds.user}`,
      `      MYSQL_PASSWORD: ${dbCreds.password}`,
      `      MYSQL_ROOT_PASSWORD: ${dbCreds.rootPassword}`,
      '    volumes:',
      `      - ${stackName}_db_data:/var/lib/mysql`,
      '    restart: unless-stopped',
    );
  }
  if (includeRedis) {
    lines.push(
      '  redis:',
      '    image: redis:alpine',
      '    container_name: ' + stackName + '_redis',
      '    restart: unless-stopped',
    );
  }

  lines.push('volumes:');
  if (framework === 'laravel') lines.push(`  ${stackName}_storage:`);
  if (includeMysql) lines.push(`  ${stackName}_db_data:`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Deploy aplikasi BARU lewat Docker Compose - beda dari deployNew.js
 * (deploy PM2/native) dan docker.js runContainer() (jalanin 1 image jadi).
 * Ini yang genuinely "build dari git repo jadi container jalan otomatis".
 *
 * Alurnya SENGAJA sinkron (dipanggil dari job worker terpisah, mirip
 * deployWorker.js) karena `docker compose build` bisa makan waktu menitan
 * (composer install / npm install di dalam container).
 */
function deployCompose(opts, onStep = () => {}) {
  const { stackName, folderPath, deployUser, gitRepo, cloneUrl, branch, port, includeMysql, includeRedis } = opts;
  const report = (step, ok, message) => onStep(step, ok, message);

  if (!isValidStackName(stackName)) {
    report('Validasi', false, 'Nama stack tidak valid (huruf/angka/underscore/dash saja).');
    return { ok: false, stoppedAt: 'Validasi' };
  }

  const safetyResult = safety.preDeployCheck({ folder: folderPath, port, domain: null });
  if (!safetyResult.allPass) {
    const summary = safetyResult.checks.map((c) => `${c.name}: ${c.message}`).join(' | ');
    report('Safety Check', false, summary);
    return { ok: false, stoppedAt: 'Safety Check' };
  }
  report('Safety Check', true, 'OK');

  const mkdirResult = shell.runArgs('sudo', ['mkdir', '-p', folderPath]);
  if (!mkdirResult.ok) { report('Siapkan Folder', false, mkdirResult.errorMessage); return { ok: false, stoppedAt: 'Siapkan Folder' }; }
  const chownResult = shell.runArgs('sudo', ['chown', '-R', `${deployUser}:${deployUser}`, folderPath]);
  if (!chownResult.ok) { report('Siapkan Folder', false, chownResult.errorMessage); return { ok: false, stoppedAt: 'Siapkan Folder' }; }
  report('Siapkan Folder', true, `Folder "${folderPath}" siap.`);

  // FIXED: bug keamanan nyata - sama kayak deployNew.js, `cloneUrl` bisa
  // mengandung PAT GitHub tersisip tapi kena log mentah ke stdout PM2 tanpa
  // `silent: true`.
  const cloneResult = shell.runAsUserArgs(deployUser, 'git', ['clone', '-b', branch, cloneUrl || gitRepo, folderPath], { timeoutMs: 5 * 60 * 1000, silent: true });
  if (!cloneResult.ok) {
    cleanup.deleteProjectFolder(deployUser, folderPath, { asRoot: true });
    report('Git Clone', false, cloneResult.errorMessage);
    return { ok: false, stoppedAt: 'Git Clone' };
  }
  report('Git Clone', true, 'Repo berhasil di-clone.');

  const framework = detectFramework(folderPath, deployUser);
  report('Deteksi Framework', true, `Terdeteksi: ${framework}`);

  const hasDockerfile = shell.runAsUser(deployUser, `test -f "${folderPath}/Dockerfile" && echo yes || echo no`, { silent: true }).output === 'yes';
  if (!hasDockerfile) {
    const dockerfileContent = dockerfileFor(framework);
    const writeResult = shell.runAsUser(deployUser, `cat > Dockerfile << 'VPSMGR_DOCKERFILE_EOF'\n${dockerfileContent}\nVPSMGR_DOCKERFILE_EOF`, { cwd: folderPath });
    if (!writeResult.ok) { report('Generate Dockerfile', false, writeResult.errorMessage); return { ok: false, stoppedAt: 'Generate Dockerfile' }; }
    report('Generate Dockerfile', true, `Dockerfile (${framework}) dibuat otomatis.`);

    if (framework === 'laravel') {
      const mkdirDocker = shell.runAsUser(deployUser, 'mkdir -p docker', { cwd: folderPath });
      const nginxWrite = shell.runAsUser(deployUser, `cat > docker/nginx.conf << 'VPSMGR_NGINX_EOF'\n${laravelNginxConf()}\nVPSMGR_NGINX_EOF`, { cwd: folderPath });
      const supervisordWrite = shell.runAsUser(deployUser, `cat > docker/supervisord.conf << 'VPSMGR_SUPERVISORD_EOF'\n${laravelSupervisordConf()}\nVPSMGR_SUPERVISORD_EOF`, { cwd: folderPath });
      if (!mkdirDocker.ok || !nginxWrite.ok || !supervisordWrite.ok) {
        report('Generate Config Container', false, [mkdirDocker, nginxWrite, supervisordWrite].find((r) => !r.ok).errorMessage);
        return { ok: false, stoppedAt: 'Generate Config Container' };
      }
      report('Generate Config Container', true, 'nginx.conf + supervisord.conf dibuat otomatis.');
    }
  } else {
    report('Generate Dockerfile', true, 'Project sudah punya Dockerfile sendiri, dipakai apa adanya.');
  }

  const dbCreds = includeMysql
    ? { database: `${stackName}_db`, user: `${stackName}_user`, password: generateDbPassword(), rootPassword: generateDbPassword() }
    : null;
  const composeContent = generateComposeFile({ stackName, framework, port, includeMysql, includeRedis, dbCreds });
  const composeWrite = shell.runAsUser(deployUser, `cat > docker-compose.yml << 'VPSMGR_COMPOSE_EOF'\n${composeContent}\nVPSMGR_COMPOSE_EOF`, { cwd: folderPath });
  if (!composeWrite.ok) { report('Generate docker-compose.yml', false, composeWrite.errorMessage); return { ok: false, stoppedAt: 'Generate docker-compose.yml' }; }
  report('Generate docker-compose.yml', true, 'OK.');

  // .env buat container app (beda dari .env project biasa - ini yang
  // di-inject via env_file: di compose). Kalau project udah bawa .env dari
  // git (jarang, biasanya di-gitignore), TIDAK ditimpa.
  const hasEnv = shell.runAsUser(deployUser, `test -f "${folderPath}/.env" && echo yes || echo no`, { silent: true }).output === 'yes';
  if (!hasEnv) {
    const envLines = ['APP_ENV=production', 'APP_DEBUG=false'];
    if (framework === 'laravel') {
      // Laravel WAJIB APP_KEY (format asli: base64:<32 byte random base64>)
      // buat enkripsi session/cookie - tanpa ini app selalu crash
      // "No application encryption key has been specified" walau
      // composer install-nya sendiri sukses. Digenerate sendiri di sini
      // (bukan lewat `php artisan key:generate` di dalam container) biar
      // gak perlu exec masuk container cuma buat 1 langkah ini.
      const appKey = 'base64:' + crypto.randomBytes(32).toString('base64');
      envLines.push(`APP_KEY=${appKey}`);
    }
    if (includeMysql) {
      envLines.push('DB_CONNECTION=mysql', 'DB_HOST=db', 'DB_PORT=3306', `DB_DATABASE=${dbCreds.database}`, `DB_USERNAME=${dbCreds.user}`, `DB_PASSWORD=${dbCreds.password}`);
    }
    if (includeRedis) envLines.push('REDIS_HOST=redis', 'REDIS_PORT=6379');
    const envWrite = shell.runAsUser(deployUser, `cat > .env << 'VPSMGR_ENV_EOF'\n${envLines.join('\n')}\nVPSMGR_ENV_EOF`, { cwd: folderPath });
    if (!envWrite.ok) { report('Generate .env', false, envWrite.errorMessage); return { ok: false, stoppedAt: 'Generate .env' }; }
    report('Generate .env', true, includeMysql ? 'Dibuat otomatis dengan kredensial DB (lihat hasil akhir).' : 'Dibuat otomatis (default).');
  } else {
    report('Generate .env', true, 'Project sudah punya .env sendiri, dipakai apa adanya.');
  }

  // docker compose build/up jalan LEWAT SUDO SEBAGAI ROOT (bukan
  // shell.runAsUser/deployUser) - deployUser sengaja TIDAK dikasih akses
  // langsung ke docker socket (bukan anggota grup `docker`, lihat catatan
  // di scripts/setup-sudoers.sh), cuma lewat sudo scoped persis kayak
  // docker.js (start/stop/restart/run container). `cwd` di sini yang bikin
  // compose baca docker-compose.yml/.env dari folder project yang benar.
  const buildResult = shell.runArgs('sudo', ['docker', 'compose', 'build'], { cwd: folderPath, timeoutMs: 15 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
  if (!buildResult.ok) { report('Docker Build', false, buildResult.errorMessage); return { ok: false, stoppedAt: 'Docker Build' }; }
  report('Docker Build', true, 'Image berhasil di-build.');

  const upResult = shell.runArgs('sudo', ['docker', 'compose', 'up', '-d'], { cwd: folderPath, timeoutMs: 5 * 60 * 1000 });
  if (!upResult.ok) { report('Docker Up', false, upResult.errorMessage); return { ok: false, stoppedAt: 'Docker Up' }; }
  report('Docker Up', true, 'Container jalan.');

  // Migrasi database - WAJIB buat Laravel modern (session driver default =
  // "database", butuh tabel `sessions` bahkan buat nampilin halaman
  // pertama, dibuktikan lewat tes deploy real: connect DB sukses tapi
  // crash "Base table ... sessions doesn't exist" sampai step ini
  // ditambahin). Retry beberapa kali dengan jeda - container `db` baru
  // `Up` bukan berarti MySQL-nya udah SIAP nerima koneksi (butuh beberapa
  // detik inisialisasi pertama kali).
  if (framework === 'laravel' && includeMysql) {
    let migrateResult;
    for (let attempt = 1; attempt <= 5; attempt++) {
      migrateResult = shell.runArgs('sudo', ['docker', 'compose', 'exec', '-T', 'app', 'php', 'artisan', 'migrate', '--force'], { cwd: folderPath, timeoutMs: 60 * 1000 });
      if (migrateResult.ok) break;
      if (attempt < 5) shell.runArgs('sleep', ['5']); // tunggu MySQL siap, coba lagi
    }
    if (!migrateResult.ok) {
      report('Migrasi Database', false, `Gagal setelah 5x percobaan: ${migrateResult.errorMessage}. App tetap jalan, migrasi bisa dicoba manual lewat Terminal: docker compose exec app php artisan migrate --force`);
    } else {
      report('Migrasi Database', true, 'Migrasi berhasil.');
    }
  }

  return { ok: true, framework, dbCreds };
}

function listStacks(baseFolder, deployUser) {
  // Semua project docker-compose ditandai lewat keberadaan docker-compose.yml
  // di dalam folder deploy standar - dicari via find, bukan disimpen di
  // registry terpisah, biar 1 sumber kebenaran (folder itu sendiri).
  const result = shell.runAsUser(deployUser, `find "${baseFolder}" -maxdepth 2 -name docker-compose.yml 2>/dev/null`, { silent: true });
  if (!result.ok) return { ok: false, stacks: [], errorMessage: result.errorMessage };
  const stacks = result.output.split('\n').filter(Boolean).map((p) => path.dirname(p));
  return { ok: true, stacks };
}

function composeAction(folderPath, action) {
  const argsFor = { down: ['down'], restart: ['restart'], logs: ['logs', '--tail', '100'] };
  const args = argsFor[action];
  if (!args) return { ok: false, errorMessage: 'Aksi tidak dikenal.' };
  return shell.runArgs('sudo', ['docker', 'compose', ...args], { cwd: folderPath, silent: true, maxBuffer: 5 * 1024 * 1024 });
}

module.exports = { detectFramework, deployCompose, listStacks, composeAction, isValidStackName };
