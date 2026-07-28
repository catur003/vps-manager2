#!/usr/bin/env node
/**
 * Test otomatis untuk semua bug yang sudah difix (Bug #2-#6, #12, Issue #7-#8).
 *
 * CARA PAKAI:
 *   node scripts/test-fixes.js
 *
 * AMAN dijalankan berkali-kali di project asli (termasuk di VPS produksi):
 * - Semua data test pakai prefix "__selftest_" dan DIHAPUS lagi di akhir tiap test.
 * - TIDAK butuh sudo, TIDAK menyentuh PM2/nginx/git/database beneran.
 * - TIDAK menjalankan deploy sungguhan - cuma nguji logic internal (registry
 *   lock, redact, validasi, timeout, atomic write).
 *
 * Kalau ada test yang gagal, JANGAN lanjut ke Fase C - laporkan dulu.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function ok(label) {
  passed++;
  console.log(`  \x1b[32m✔\x1b[0m ${label}`);
}

function fail(label, detail) {
  failed++;
  failures.push(label);
  console.log(`  \x1b[31m✘ ${label}\x1b[0m`);
  if (detail) console.log(`    ${String(detail).split('\n').join('\n    ')}`);
}

function section(title) {
  console.log(`\n\x1b[36m▶ ${title}\x1b[0m`);
}

async function main() {
  console.log('=== Test Fix: VPS Manager (Bug #2-#6, Issue #7-#8) ===');

  // ---------------------------------------------------------------
  section('1. Registry - race condition (Bug #3)');
  // ---------------------------------------------------------------
  {
    const registry = require(path.join(ROOT, 'src/registry/registry'));
    const N = 12;
    const prefix = '__selftest_race_';

    // Bersihin sisa test sebelumnya kalau ada (misal run sebelumnya gagal di tengah)
    registry.listProjects().filter((p) => p.name.startsWith(prefix)).forEach((p) => {
      try { registry.removeProject(p.name); } catch (e) {}
    });

    const childScript = `
      const registry = require(${JSON.stringify(path.join(ROOT, 'src/registry/registry'))});
      const i = process.argv[1];
      try {
        registry.addProject({ name: '${prefix}' + i, port: 59000 + Number(i), domain: '${prefix}' + i + '.local', path: '/tmp/${prefix}' + i, deploy_user: 'www' });
        process.exit(0);
      } catch (err) {
        console.error(err.message);
        process.exit(1);
      }
    `;

    try {
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          new Promise((resolve) => {
            const child = spawn(process.execPath, ['-e', childScript, '--', String(i)]);
            child.on('close', (code) => resolve(code));
          })
        )
      );

      const allSucceeded = results.every((code) => code === 0);
      const registered = registry.listProjects().filter((p) => p.name.startsWith(prefix));

      if (allSucceeded && registered.length === N) {
        ok(`${N} proses node terpisah nulis registry.json barengan → ${registered.length}/${N} kedaftar, tidak ada yang hilang`);
      } else {
        fail('Sebagian project hilang/gagal saat ditulis barengan', `Sukses proses: ${results.filter((c) => c === 0).length}/${N}, kedaftar di registry: ${registered.length}/${N}`);
      }
    } finally {
      registry.listProjects().filter((p) => p.name.startsWith(prefix)).forEach((p) => {
        try { registry.removeProject(p.name); } catch (e) {}
      });
    }
  }

  // ---------------------------------------------------------------
  section('2. Permission file kredensial (Bug #4)');
  // ---------------------------------------------------------------
  {
    const config = require(path.join(ROOT, 'src/config/config'));
    const dbRegistry = require(path.join(ROOT, 'src/registry/dbRegistry'));
    const jobStore = require(path.join(ROOT, 'src/api/jobs/jobStore'));

    // paksa masing-masing nulis ulang filenya
    config.saveConfig(config.loadConfig());
    dbRegistry.upsertEntry({ dbName: '__selftest_dbcheck__', dbUser: 'x', password: 'x', connectionUrl: 'x' });
    dbRegistry.removeEntry('__selftest_dbcheck__');
    const jobId = jobStore.createJob('__selftest__', {});

    const checks = [
      ['config.json', config.CONFIG_PATH || path.join(ROOT, 'data/config.json')],
      ['db-registry.json', path.join(ROOT, 'data/db-registry.json')],
      ['jobs.json', jobStore.JOBS_PATH],
    ];

    for (const [label, filePath] of checks) {
      try {
        const mode = (fs.statSync(filePath).mode & 0o777).toString(8);
        if (mode === '600') {
          ok(`${label} permission 600`);
        } else {
          fail(`${label} permission SALAH`, `Ketemu ${mode}, harusnya 600`);
        }
      } catch (err) {
        fail(`${label} gagal dicek`, err.message);
      }
    }

    // cleanup job test
    const data = JSON.parse(fs.readFileSync(jobStore.JOBS_PATH, 'utf-8'));
    delete data.jobs[jobId];
    fs.writeFileSync(jobStore.JOBS_PATH, JSON.stringify(data, null, 2));
  }

  // ---------------------------------------------------------------
  section('3. jobStore - envContent tidak ke-redact buat worker (Bug #2)');
  // ---------------------------------------------------------------
  {
    const jobStore = require(path.join(ROOT, 'src/api/jobs/jobStore'));
    const secret = 'DATABASE_URL=mysql://real:s3cr3t@localhost/db';
    const id = jobStore.createJob('__selftest__', { name: 'x', envContent: secret, gitRepo: 'https://x' });

    const rawJob = jobStore.getJob(id);
    const publicJob = jobStore.toPublicJob(rawJob);

    if (rawJob.params.envContent === secret) {
      ok('Worker (jobStore.getJob) tetap dapat envContent ASLI');
    } else {
      fail('Worker dapat envContent yang SALAH', `Diharap: "${secret}", ketemu: "${rawJob.params.envContent}"`);
    }

    if (publicJob.params.envContent === '[REDACTED]') {
      ok('API response (toPublicJob) envContent ke-redact');
    } else {
      fail('API response envContent TIDAK ke-redact', `Ketemu: "${publicJob.params.envContent}"`);
    }

    // cleanup
    const data = JSON.parse(fs.readFileSync(jobStore.JOBS_PATH, 'utf-8'));
    delete data.jobs[id];
    fs.writeFileSync(jobStore.JOBS_PATH, JSON.stringify(data, null, 2));
  }

  // ---------------------------------------------------------------
  section('4. shell.js - timeout tidak nge-hang selamanya (Bug #6)');
  // ---------------------------------------------------------------
  {
    const shell = require(path.join(ROOT, 'src/utils/shell'));
    const start = Date.now();
    // command 'sleep 5' dipaksa timeout di 500ms - command aman, gak butuh sudo
    const result = shell.run('sleep 5', { timeoutMs: 500, silent: true });
    const elapsedMs = Date.now() - start;

    if (!result.ok && /timeout/i.test(result.errorMessage) && elapsedMs < 4000) {
      ok(`Command yang nyangkut dipaksa berhenti di ~${elapsedMs}ms (bukan nunggu 5 detik penuh)`);
    } else {
      fail('Timeout tidak bekerja seperti diharapkan', `ok=${result.ok}, elapsed=${elapsedMs}ms, message="${result.errorMessage}"`);
    }
  }

  // ---------------------------------------------------------------
  section('5. Validasi prismaMode (Bug #5)');
  // ---------------------------------------------------------------
  {
    const deployRoutes = require(path.join(ROOT, 'src/api/routes/deploy.routes'));
    const baseBody = { name: 'demo', domain: 'demo.local', gitRepo: 'https://x', port: 3000, folderPath: '/tmp/demo' };

    const invalid = deployRoutes.validateBody({ ...baseBody, prismaMode: 'pusg' });
    const valid = deployRoutes.validateBody({ ...baseBody, prismaMode: 'push' });
    const empty = deployRoutes.validateBody({ ...baseBody });

    if (invalid !== true) {
      ok('prismaMode typo ("pusg") ditolak dengan pesan error');
    } else {
      fail('prismaMode typo LOLOS validasi (harusnya ditolak)');
    }

    if (valid === true) {
      ok('prismaMode valid ("push") diterima');
    } else {
      fail('prismaMode valid malah ditolak', valid);
    }

    if (empty === true) {
      ok('prismaMode kosong (opsional) tetap diterima');
    } else {
      fail('prismaMode kosong malah ditolak', empty);
    }
  }

  // ---------------------------------------------------------------
  section('6. Log step dipotong kalau kepanjangan (Issue #7)');
  // ---------------------------------------------------------------
  {
    const jobStore = require(path.join(ROOT, 'src/api/jobs/jobStore'));
    const id = jobStore.createJob('__selftest__', {});
    const longMessage = 'X'.repeat(5000) + 'PENANDA_AKHIR';

    jobStore.appendJobStep(id, { step: 'Test', ok: false, message: longMessage });
    const job = jobStore.getJob(id);
    const savedMessage = job.steps[job.steps.length - 1].message;

    if (savedMessage.length < 5000 && savedMessage.endsWith('PENANDA_AKHIR')) {
      ok(`Message 5000 karakter dipotong jadi ${savedMessage.length} karakter, bagian akhir (paling relevan) tetap ada`);
    } else {
      fail('Log tidak terpotong dengan benar', `Panjang akhir: ${savedMessage.length}, endsWithPenanda: ${savedMessage.endsWith('PENANDA_AKHIR')}`);
    }

    // cleanup
    const data = JSON.parse(fs.readFileSync(jobStore.JOBS_PATH, 'utf-8'));
    delete data.jobs[id];
    fs.writeFileSync(jobStore.JOBS_PATH, JSON.stringify(data, null, 2));
  }

  // ---------------------------------------------------------------
  section('7. monitor.js - info swap muncul (Issue #8)');
  // ---------------------------------------------------------------
  {
    const monitor = require(path.join(ROOT, 'src/monitor/monitor'));
    const status = monitor.getStatus();
    if (status.swap && typeof status.swap.totalMB === 'number') {
      ok(`Info swap muncul di getStatus() (total: ${status.swap.totalMB}MB, used: ${status.swap.usedMB}MB)`);
    } else if (status.swap === null) {
      fail('monitor.getSwap() return null', 'Kemungkinan command `free -m` gagal jalan di environment ini (cek manual: jalankan `free -m` langsung)');
    } else {
      fail('Field swap tidak ada/rusak di getStatus()', JSON.stringify(status.swap));
    }
  }

  // ---------------------------------------------------------------
  section('8. env.js - heredoc delimiter random, gak bisa di-collide (Bug #12)');
  // ---------------------------------------------------------------
  {
    const envModule = require(path.join(ROOT, 'src/project/env'));
    const { execSync } = require('child_process');
    const testFile = '/tmp/__selftest_env_injection_test.env';
    const proofFile = '/tmp/__selftest_injection_proof.txt';
    try { fs.unlinkSync(proofFile); } catch (e) {}

    // Content SENGAJA isi baris yang sama persis kayak delimiter lama yang
    // fixed ("VPSMGR_ENV_EOF") - kalau bug-nya balik lagi, ini bakal
    // ke-eksekusi sebagai command shell beneran, bukan ketulis sebagai teks.
    const maliciousContent = `DATABASE_URL=x\nVPSMGR_ENV_EOF\necho INJECTED > ${proofFile}\nVPSMGR_ENV_EOF`;

    // Panggil writeEnv() tapi tanpa sudo (langsung jalanin command yang
    // dihasilkan lewat bash biasa) - cukup buat nguji logic heredoc-nya,
    // gak perlu env VPS beneran buat tes ini.
    const originalFn = require(path.join(ROOT, 'src/utils/shell')).runAsUser;
    const shellModule = require(path.join(ROOT, 'src/utils/shell'));
    shellModule.runAsUser = (user, command, options = {}) => {
      const { cwd = '/tmp' } = options;
      try {
        execSync(command, { cwd, shell: '/bin/bash' });
        return { ok: true };
      } catch (err) {
        return { ok: false, errorMessage: err.message };
      }
    };

    process.chdir('/tmp');
    fs.writeFileSync(testFile, ''); // pastiin file target ada di /tmp
    const tmpDir = '/tmp';
    // writeEnv nulis ke "${cwd}/.env" secara implisit lewat `cat > .env`,
    // jadi kita arahkan cwd ke folder isolated biar gak nimpa .env lain
    const isolatedDir = fs.mkdtempSync('/tmp/__selftest_env_');
    envModule.writeEnv(isolatedDir, 'irrelevant-user', maliciousContent);
    shellModule.runAsUser = originalFn; // restore

    const writtenContent = fs.readFileSync(path.join(isolatedDir, '.env'), 'utf-8');
    const injected = fs.existsSync(proofFile);

    if (!injected && writtenContent.includes('INJECTED')) {
      ok('Content dengan baris delimiter lama ketulis APA ADANYA sebagai teks, TIDAK ter-eksekusi sebagai command');
    } else {
      fail('Command injection masih terjadi!', `injected=${injected}, writtenContent="${writtenContent}"`);
    }

    fs.rmSync(isolatedDir, { recursive: true, force: true });
    try { fs.unlinkSync(testFile); } catch (e) {}
    try { fs.unlinkSync(proofFile); } catch (e) {}
  }

  // ---------------------------------------------------------------
  section('9. Fase C - resumeFromKey skip step sebelumnya (fitur retry)');
  // ---------------------------------------------------------------
  {
    const shellModule = require(path.join(ROOT, 'src/utils/shell'));
    const nginxModule = require(path.join(ROOT, 'src/nginx/nginx'));
    const registryModule = require(path.join(ROOT, 'src/registry/registry'));
    const deployNew = require(path.join(ROOT, 'src/deploy/deployNew'));

    const calledSteps = [];
    const originalRunAsUser = shellModule.runAsUser;
    const originalRunAsUserArgs = shellModule.runAsUserArgs;
    const originalRunArgs = shellModule.runArgs;
    const originalCreateSite = nginxModule.createReverseProxySite;
    const originalAddProject = registryModule.addProject;

    shellModule.runAsUser = (user, command) => {
      calledSteps.push(command);
      return { ok: true, output: '' };
    };
    // deployNew.js sekarang pakai runAsUserArgs()/runArgs() (execFileSync,
    // bukan shell string) buat step install/prisma/build/pm2 - stub ini juga
    // biar kecatet ke calledSteps yang sama (join args jadi 1 string biar
    // matching `.includes('npm install')` di bawah tetap kerja).
    shellModule.runAsUserArgs = (user, file, args) => {
      calledSteps.push([file, ...(args || [])].join(' '));
      // git rev-parse HEAD (dipanggil refreshSourceFromGit sebelum/sesudah
      // fetch+reset) HARUS balikin hash yang KONSISTEN di sini - test ini
      // sengaja mensimulasikan "source TIDAK berubah sejak attempt sebelumnya",
      // supaya expected behavior-nya (resume, skip step yang sudah sukses)
      // beneran teruji, bukan ke-treat sebagai "unknown -> full restart"
      // (fail-safe default kalau hash kosong/gagal diparse - lihat Bug #2 fix).
      if (file === 'git' && args && args.includes('rev-parse')) return { ok: true, output: 'sameHead1234567' };
      return { ok: true, output: '' };
    };
    shellModule.runArgs = (file, args) => {
      calledSteps.push([file, ...(args || [])].join(' '));
      return { ok: true, output: '' };
    };
    nginxModule.createReverseProxySite = () => {
      calledSteps.push('nginx.createReverseProxySite');
      return { ok: true };
    };
    registryModule.addProject = () => {
      calledSteps.push('registry.addProject');
      return {};
    };

    try {
      const opts = {
        name: '__selftest_resume__',
        domain: 'resume.local',
        port: 4999,
        folderPath: '/tmp/__selftest_resume__',
        deployUser: 'www',
        gitRepo: 'https://x',
        branch: 'main',
        prismaMode: 'none',
        envContent: 'X=1',
      };
      const result = deployNew.finishDeploy(opts, () => {}, 'build'); // resume dari step "build" - skip env & install

      const hitInstall = calledSteps.some((c) => typeof c === 'string' && c.includes('npm install'));
      const hitBuild = calledSteps.some((c) => typeof c === 'string' && c.includes('npm run build'));

      if (!hitInstall && hitBuild && result.ok) {
        ok('resumeFromKey="build" skip step env & install, langsung mulai dari build');
      } else {
        fail('resumeFromKey tidak skip step dengan benar', `hitInstall=${hitInstall}, hitBuild=${hitBuild}, steps=${JSON.stringify(calledSteps)}`);
      }
    } finally {
      shellModule.runAsUser = originalRunAsUser;
      shellModule.runAsUserArgs = originalRunAsUserArgs;
      shellModule.runArgs = originalRunArgs;
      nginxModule.createReverseProxySite = originalCreateSite;
      registryModule.addProject = originalAddProject;
    }
  }

  // ---------------------------------------------------------------
  section('10. Fase C - action baru terdaftar di commandPolicy');
  // ---------------------------------------------------------------
  {
    const commandPolicy = require(path.join(ROOT, 'src/api/commandPolicy'));
    const actions = ['deploy.retry', 'ssl.issue', 'database.create'];
    const missing = actions.filter((a) => !commandPolicy.isExposed(a));
    if (missing.length === 0) {
      ok('deploy.retry, ssl.issue, database.create semua ke-expose di commandPolicy');
    } else {
      fail('Ada action Fase C yang belum ke-daftar', missing.join(', '));
    }
  }

  // ---------------------------------------------------------------
  section('11. shell.runArgs() - command substitution ($()) TIDAK dieksekusi (Bug #13)');
  // ---------------------------------------------------------------
  {
    // Sebelumnya database.js runSQL()/testCredentials() membangun SATU
    // string command lalu jalanin lewat shell.run() (execSync -> shell).
    // Kalau salah satu bagiannya (mis. `password` dari body POST /database,
    // yang TIDAK ada validasi formatnya) mengandung `$(...)`, shell
    // mengeksekusi isi `$(...)` itu SEBELUM command aslinya (mis. `mysql`)
    // sempat jalan sama sekali - RCE murni, dibuktikan nyata (bukan cuma
    // teori) waktu code review, lihat CHANGELOG.
    //
    // Fix: pindah ke shell.runArgs() (execFileSync) - argumen dikirim
    // sebagai argv terpisah ke proses child, TIDAK PERNAH melewati shell,
    // jadi `$(...)` di dalamnya selalu diperlakukan sebagai teks literal.
    const shellModule = require(path.join(ROOT, 'src/utils/shell'));
    const proofFile = path.join(require('os').tmpdir(), `__selftest_shell_injection_proof_${Date.now()}`);
    try { fs.unlinkSync(proofFile); } catch (e) {}

    const maliciousArg = `x$(touch ${proofFile})y`;
    const result = shellModule.runArgs('echo', [maliciousArg], { silent: true });

    const proofFileCreated = fs.existsSync(proofFile);
    const literalPreserved = result.ok && result.output.includes('$(touch') && result.output.includes(proofFile);

    if (!proofFileCreated && literalPreserved) {
      ok('Argumen berisi $(...) diperlakukan sebagai teks literal, TIDAK dieksekusi shell');
    } else {
      fail(
        'shell.runArgs() ternyata masih bisa kena command substitution',
        `proofFileCreated=${proofFileCreated}, output=${JSON.stringify(result.output)}`
      );
    }
    try { fs.unlinkSync(proofFile); } catch (e) {}
  }

  // ---------------------------------------------------------------
  section('12. dbRegistry - password/connectionUrl encrypted at rest (Bug #3)');
  // ---------------------------------------------------------------
  {
    const dbRegistry = require(path.join(ROOT, 'src/registry/dbRegistry'));
    const dbRegPath = path.join(ROOT, 'data/db-registry.json');
    const backup = fs.existsSync(dbRegPath) ? fs.readFileSync(dbRegPath, 'utf-8') : null;
    const name = '__selftest_dbcrypt__';

    try {
      dbRegistry.removeEntry(name); // jaga-jaga sisa run sebelumnya
      const plainPassword = 'S3lfTest!Passw0rd';
      dbRegistry.upsertEntry({
        dbName: name,
        dbUser: 'selftestuser',
        password: plainPassword,
        connectionUrl: `mysql://selftestuser:${plainPassword}@127.0.0.1:3306/${name}`,
      });

      const rawDisk = fs.readFileSync(dbRegPath, 'utf-8');
      const leaked = rawDisk.includes(plainPassword);
      const backAgain = dbRegistry.findByName(name);
      const roundTripOk =
        backAgain && backAgain.password === plainPassword && backAgain.connectionUrl.includes(plainPassword);

      if (!leaked && roundTripOk) {
        ok('Password TIDAK ada plaintext di db-registry.json, tapi tetap kebaca benar lewat findByName()');
      } else {
        fail('Encryption at rest gagal', `leaked=${leaked}, roundTripOk=${roundTripOk}`);
      }

      // Backward-compat: entry lama (plaintext, dari sebelum fix ini) harus
      // tetap kebaca benar, dan otomatis ke-migrate ke encrypted begitu
      // di-upsertEntry() ulang (bukan error/hilang diam-diam).
      const oldEntries = fs
        .readFileSync(dbRegPath, 'utf-8');
      const parsed = JSON.parse(oldEntries).filter((e) => e.dbName !== name);
      parsed.push({ dbName: name, dbUser: 'selftestuser', password: plainPassword, connectionUrl: 'plain-url-marker' });
      fs.writeFileSync(dbRegPath, JSON.stringify(parsed), { mode: 0o600 }); // tulis manual (simulasi data lama, skip encrypt)

      const readOld = dbRegistry.findByName(name);
      const oldReadable = readOld && readOld.password === plainPassword;
      dbRegistry.upsertEntry(readOld); // re-save -> harus ke-encrypt
      const rawAfterMigrate = fs.readFileSync(dbRegPath, 'utf-8');
      const migratedNoLeak = !rawAfterMigrate.includes(plainPassword);

      if (oldReadable && migratedNoLeak) {
        ok('Entry plaintext lama (sebelum fix) tetap kebaca & auto-migrate ke encrypted saat di-upsert ulang');
      } else {
        fail('Backward-compat plaintext lama gagal', `oldReadable=${oldReadable}, migratedNoLeak=${migratedNoLeak}`);
      }
    } finally {
      dbRegistry.removeEntry(name);
      if (backup !== null) fs.writeFileSync(dbRegPath, backup);
      else { try { fs.unlinkSync(dbRegPath); } catch (e) {} }
    }
  }

  // ---------------------------------------------------------------
  section('13. registry.isProjectAlive() - fail-safe default (Bug #1)');
  // ---------------------------------------------------------------
  {
    const shellModule = require(path.join(ROOT, 'src/utils/shell'));
    const registry = require(path.join(ROOT, 'src/registry/registry'));
    const originalRunAsUser = shellModule.runAsUser;
    const originalRun = shellModule.run;

    try {
      // Skenario A: semua sinyal GAGAL DICEK (command error) -> HARUS default
      // alive=true (fail-safe), BUKAN diam-diam dianggap mati lalu di-prune.
      shellModule.runAsUser = () => ({ ok: false, output: '', errorMessage: 'simulasi gagal' });
      shellModule.run = () => ({ ok: false, output: '', errorMessage: 'simulasi gagal' });
      const uncertain = registry.isProjectAlive({
        name: '__selftest_uncertain__',
        path: '/tmp/__selftest_definitely_missing__',
        deploy_user: 'www',
        domain: 'selftest-uncertain.local',
      });
      if (uncertain.alive === true && uncertain.pm2Status === 'unknown' && uncertain.nginxStatus === 'unknown') {
        ok('Sinyal tidak bisa dipastikan (command gagal semua) -> default alive=true (fail-safe, tidak asal prune)');
      } else {
        fail('Fail-safe default salah', JSON.stringify(uncertain));
      }

      // Skenario B: SEMUA sinyal POSITIF konfirmasi mati (folder gak ada, PM2
      // jlist sukses dan nama app gak ketemu, nginx conf gak ada) -> BARU
      // dianggap alive=false (definitely dead).
      shellModule.runAsUser = () => ({ ok: true, output: '[]' }); // pm2 jlist kosong = app pasti gak ada
      shellModule.run = () => ({ ok: true, output: 'MISSING' }); // nginx conf gak ada
      const dead = registry.isProjectAlive({
        name: '__selftest_dead__',
        path: '/tmp/__selftest_definitely_missing_too__',
        deploy_user: 'www',
        domain: 'selftest-dead.local',
      });
      if (dead.alive === false && dead.pm2Status === 'absent' && dead.nginxStatus === 'absent') {
        ok('Semua sinyal positif konfirmasi mati -> alive=false (baru dianggap stale, boleh di-prune)');
      } else {
        fail('Deteksi "benar-benar mati" salah', JSON.stringify(dead));
      }
    } finally {
      shellModule.runAsUser = originalRunAsUser;
      shellModule.run = originalRun;
    }
  }

  // ---------------------------------------------------------------
  section('14. safety.checkPort/checkDomain - auto-prune stale registry entry (Bug #1)');
  // ---------------------------------------------------------------
  {
    const shellModule = require(path.join(ROOT, 'src/utils/shell'));
    const registry = require(path.join(ROOT, 'src/registry/registry'));
    const safety = require(path.join(ROOT, 'src/safety/safety'));
    const originalRunAsUser = shellModule.runAsUser;
    const originalRun = shellModule.run;
    const staleName = '__selftest_stale_project__';

    try {
      try { registry.removeProject(staleName); } catch (e) {}
      registry.addProject({
        name: staleName,
        port: 58999,
        domain: 'selftest-stale.local',
        path: '/tmp/__selftest_stale_path_definitely_missing__',
        deploy_user: 'www',
      });

      // Simulasikan project ini SUDAH MATI TOTAL di real system (folder udah
      // gak ada dari addProject di atas, PM2 kosong, nginx conf gak ada).
      shellModule.runAsUser = () => ({ ok: true, output: '[]' });
      shellModule.run = () => ({ ok: true, output: 'MISSING' });

      const portCheck = safety.checkPort(58999);
      const domainCheck = safety.checkDomain('selftest-stale.local');
      const stillInRegistry = registry.findProject(staleName);

      if (portCheck.pass && domainCheck.pass && !stillInRegistry) {
        ok('Port/domain project basi otomatis di-prune, Safety Check jadi PASS (tidak salah blokir deploy ulang)');
      } else {
        fail(
          'Auto-prune stale registry entry gagal',
          `portCheck.pass=${portCheck.pass}, domainCheck.pass=${domainCheck.pass}, stillInRegistry=${!!stillInRegistry}`
        );
      }

      // Skenario kontrol: project MASIH aktif (PM2 ketemu) -> HARUS tetap
      // diblokir seperti biasa, TIDAK boleh ke-prune.
      try { registry.removeProject(staleName); } catch (e) {}
      registry.addProject({
        name: staleName,
        port: 58999,
        domain: 'selftest-stale.local',
        path: '/tmp/__selftest_stale_path_definitely_missing__',
        deploy_user: 'www',
      });
      shellModule.runAsUser = () => ({ ok: true, output: JSON.stringify([{ name: staleName, pm2_env: { status: 'online' } }]) });
      shellModule.run = () => ({ ok: true, output: 'MISSING' });

      const portCheckAlive = safety.checkPort(58999);
      const stillInRegistryAlive = registry.findProject(staleName);

      if (!portCheckAlive.pass && stillInRegistryAlive) {
        ok('Project yang masih aktif TETAP diblokir seperti biasa (tidak salah prune data valid)');
      } else {
        fail('Kontrol negatif gagal - project aktif malah ke-prune/diloloskan', JSON.stringify(portCheckAlive));
      }
    } finally {
      shellModule.runAsUser = originalRunAsUser;
      shellModule.run = originalRun;
      try { registry.removeProject(staleName); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------
  section('15. cleanup.deleteProjectFolder() - guard dangkal & blacklist (Delete Project)');
  // ---------------------------------------------------------------
  {
    const cleanup = require(path.join(ROOT, 'src/cleanup/cleanup'));
    const shallow = cleanup.deleteProjectFolder('www', '/www');
    const blacklisted = cleanup.deleteProjectFolder('www', '/etc');
    const deepBlacklisted = cleanup.deleteProjectFolder('www', '/var/lib/mysql/foo');

    if (!shallow.ok && !blacklisted.ok && !deepBlacklisted.ok) {
      ok('Path dangkal & folder sistem (termasuk sub-path-nya) ditolak, tidak asal rm -rf');
    } else {
      fail(
        'Guard deleteProjectFolder gagal',
        `shallow.ok=${shallow.ok}, blacklisted.ok=${blacklisted.ok}, deepBlacklisted.ok=${deepBlacklisted.ok}`
      );
    }
  }

  // ---------------------------------------------------------------
  section('16. deleteProject.execute() - orchestration PM2/Nginx/DB/Registry (fitur baru)');
  // ---------------------------------------------------------------
  {
    const shellModule = require(path.join(ROOT, 'src/utils/shell'));
    const registry = require(path.join(ROOT, 'src/registry/registry'));
    const dbRegistry = require(path.join(ROOT, 'src/registry/dbRegistry'));
    const deleteProject = require(path.join(ROOT, 'src/project/deleteProject'));
    const originalRunAsUser = shellModule.runAsUser;
    const originalRun = shellModule.run;
    const name = '__selftest_delproj__';
    const dbName = '__selftest_delproj_db__';

    try {
      try { registry.removeProject(name); } catch (e) {}
      try { dbRegistry.removeEntry(dbName); } catch (e) {}

      registry.addProject({ name, port: 59111, domain: 'selftest-del.local', path: '/tmp/__selftest_delproj_folder__', deploy_user: 'www' });
      dbRegistry.upsertEntry({ dbName, dbUser: 'selftestuser_del', password: 'x', usedByProject: name });

      shellModule.runAsUser = (owner, cmd) => {
        if (cmd.includes('pm2 delete') || cmd.includes('pm2 save')) return { ok: true, output: 'ok' };
        return { ok: true, output: '[]' };
      };
      shellModule.run = () => ({ ok: true, output: '' }); // nginx: ls kosong -> no sites

      const project = registry.findProject(name);
      const { results } = deleteProject.execute(project, { deletePm2: true, deleteNginx: true, dropDatabases: false, deleteFolder: false });

      const registryGone = !registry.findProject(name);
      const dbStillExists = !!dbRegistry.findByName(dbName);
      const dbUnlinked = dbStillExists && dbRegistry.findByName(dbName).usedByProject === null;
      const allStepsOk = results.every((r) => r.ok);

      if (registryGone && dbStillExists && dbUnlinked && allStepsOk) {
        ok('Delete Project (default opts): PM2+Nginx+Registry beres, database TIDAK ikut kehapus - cuma di-unlink dari project');
      } else {
        fail(
          'deleteProject.execute() default opts salah',
          `registryGone=${registryGone}, dbStillExists=${dbStillExists}, dbUnlinked=${dbUnlinked}, allStepsOk=${allStepsOk}`
        );
      }
    } finally {
      shellModule.runAsUser = originalRunAsUser;
      shellModule.run = originalRun;
      try { registry.removeProject(name); } catch (e) {}
      try { dbRegistry.removeEntry(dbName); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------
  section('17. deleteProject.execute() - nginx check gagal HARUS dilaporkan, bukan silent-skip (bug baru ketemu)');
  // ---------------------------------------------------------------
  {
    const shellModule = require(path.join(ROOT, 'src/utils/shell'));
    const registry = require(path.join(ROOT, 'src/registry/registry'));
    const dbRegistry = require(path.join(ROOT, 'src/registry/dbRegistry'));
    const deleteProject = require(path.join(ROOT, 'src/project/deleteProject'));
    const originalRunAsUser = shellModule.runAsUser;
    const originalRun = shellModule.run;
    const name = '__selftest_delproj_nginxfail__';

    try {
      try { registry.removeProject(name); } catch (e) {}
      registry.addProject({ name, port: 59112, domain: 'selftest-nginxfail.local', path: '/tmp/__selftest_nope__', deploy_user: 'www' });

      shellModule.runAsUser = () => ({ ok: true, output: '[]' });
      shellModule.run = () => ({ ok: false, output: '', errorMessage: 'Permission denied (simulasi)' }); // nginx listSites gagal

      const project = registry.findProject(name);
      const preview = deleteProject.preview(project);
      const { results } = deleteProject.execute(project, { deletePm2: false, deleteNginx: true, dropDatabases: false, deleteFolder: false });
      const nginxStep = results.find((r) => r.step === 'Nginx Site');

      if (preview.nginxCheckFailed === true && nginxStep && nginxStep.ok === false) {
        ok('Gagal cek nginx (bukan gagal karena site emang nggak ada) dilaporkan sebagai FAILED, bukan diam-diam "dilewati aman"');
      } else {
        fail('Nginx check-failure masih ke-silent-skip', `preview.nginxCheckFailed=${preview.nginxCheckFailed}, nginxStep=${JSON.stringify(nginxStep)}`);
      }
    } finally {
      shellModule.runAsUser = originalRunAsUser;
      shellModule.run = originalRun;
      try { registry.removeProject(name); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------
  section('18. deployNew.finishDeploy() retry - refresh source dari GitHub (Bug #2)');
  // ---------------------------------------------------------------
  {
    const shellModule = require(path.join(ROOT, 'src/utils/shell'));
    const registry = require(path.join(ROOT, 'src/registry/registry'));
    const deployNew = require(path.join(ROOT, 'src/deploy/deployNew'));
    const originalRunAsUserArgs = shellModule.runAsUserArgs;
    const originalRun = shellModule.run;
    const name = '__selftest_retry__';
    const baseOpts = {
      name,
      gitRepo: 'https://github.com/x/y.git',
      branch: 'main',
      domain: 'selftest-retry.local',
      port: 59200,
      folderPath: '/tmp/selftest_retry',
      deployUser: 'www',
      envContent: '',
      prismaMode: 'none',
    };

    function mockShell(sourceChanged) {
      let revParseCall = 0;
      shellModule.runAsUserArgs = (user, file, args) => {
        if (file === 'git' && args.includes('rev-parse')) {
          revParseCall++;
          return { ok: true, output: revParseCall === 1 ? 'aaa1111' : sourceChanged ? 'bbb2222' : 'aaa1111' };
        }
        return { ok: true, output: '' };
      };
      shellModule.run = () => ({ ok: true, output: '' });
    }

    try {
      // Skenario A: source TIDAK berubah -> resume dari 'build' seperti biasa,
      // step 'NPM Install' (sebelum 'build') HARUS di-skip (tidak diulang).
      try { registry.removeProject(name); } catch (e) {}
      mockShell(false);
      const resA = deployNew.finishDeploy(baseOpts, () => {}, 'build');
      const installRanA = resA.steps.some((s) => s.step === 'NPM Install');
      try { registry.removeProject(name); } catch (e) {}

      // Skenario B: source BERUBAH sejak attempt sebelumnya -> HARUS restart
      // dari awal, step 'NPM Install' HARUS ikut jalan lagi (bukan di-skip).
      mockShell(true);
      const resB = deployNew.finishDeploy(baseOpts, () => {}, 'build');
      const installRanB = resB.steps.some((s) => s.step === 'NPM Install');
      try { registry.removeProject(name); } catch (e) {}

      if (installRanA === false && installRanB === true) {
        ok('Retry pakai source TERBARU dari GitHub: source sama -> resume hemat (install di-skip), source beda -> full restart (install diulang)');
      } else {
        fail('Logika refresh source retry salah', `installRanA=${installRanA} (harus false), installRanB=${installRanB} (harus true)`);
      }

      // Skenario C: git fetch gagal (mis. network) -> stoppedAtKey HARUS TETAP
      // sama dengan resumeFromKey semula (bukan key baru/hilang), dan
      // dilaporkan sebagai step GAGAL yang jelas (bukan silent).
      shellModule.runAsUserArgs = (user, file, args) => {
        if (file === 'git' && args.includes('fetch')) return { ok: false, output: '', errorMessage: 'simulasi network error' };
        return { ok: true, output: '' };
      };
      const resC = deployNew.finishDeploy(baseOpts, () => {}, 'build');
      if (resC.ok === false && resC.stoppedAtKey === 'build' && resC.steps.some((s) => s.step === 'Refresh Source (git fetch)' && !s.ok)) {
        ok('git fetch gagal saat retry: dilaporkan jelas sebagai step gagal, stoppedAtKey TIDAK berubah (retry berikutnya tetap nyoba dari titik yang sama)');
      } else {
        fail('Penanganan fetch gagal salah', JSON.stringify({ ok: resC.ok, stoppedAtKey: resC.stoppedAtKey }));
      }

      // Skenario D: gagal BUKAN di step build (mis. 'nginx' atau 'pm2_start')
      // - pastiin fix ini jalan konsisten di step manapun, bukan cuma 'build'.
      mockShell(false);
      const resD = deployNew.finishDeploy(baseOpts, () => {}, 'nginx');
      const buildRanD = resD.steps.some((s) => s.step === 'Build');
      try { registry.removeProject(name); } catch (e) {}
      if (resD.ok === true && buildRanD === false) {
        ok('Retry dari step selain "build" (mis. "nginx") juga konsisten: source sama -> step sebelumnya (Build, dst) tetap di-skip');
      } else {
        fail('Retry dari step non-build salah', `resD.ok=${resD.ok}, buildRanD=${buildRanD}`);
      }
    } finally {
      shellModule.runAsUserArgs = originalRunAsUserArgs;
      shellModule.run = originalRun;
      try { registry.removeProject(name); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------
  console.log('\n=======================================');
  console.log(`Hasil: ${passed} passed, ${failed} failed`);
  console.log('=======================================');
  if (failed > 0) {
    console.log('\nTest yang gagal:');
    failures.forEach((f) => console.log(`  - ${f}`));
    console.log('\n⚠️  JANGAN lanjut ke Fase C dulu - laporkan hasil ini.');
    process.exit(1);
  } else {
    console.log('\n✅ Semua fix lolos test. Aman lanjut ke uji manual Fase B (deploy beneran) atau Fase C.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Script test error:', err);
  process.exit(1);
});
