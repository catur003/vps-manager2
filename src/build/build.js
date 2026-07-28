const shell = require('../utils/shell');

/**
 * Cek apakah sebuah file ada di dalam folder project (relatif ke root project).
 * Dipakai buat deteksi otomatis (mis. project ini pakai Prisma apa nggak).
 */
function hasFile(projectPath, deployUser, relativePath) {
  const result = shell.runAsUser(deployUser, `test -f "${relativePath}" && echo yes || echo no`, {
    cwd: projectPath,
    silent: true,
  });
  return result.ok && result.output.trim() === 'yes';
}

function hasPrismaSchema(projectPath, deployUser) {
  return hasFile(projectPath, deployUser, 'prisma/schema.prisma');
}

function hasPackageJson(projectPath, deployUser) {
  return hasFile(projectPath, deployUser, 'package.json');
}

/**
 * Semua command di bawah ini butuh waktu & output lumayan panjang (terutama
 * npm install/build), makanya maxBuffer dinaikin biar nggak gagal ke-cut
 * gara-gara output kepanjangan (default execSync cuma 1MB).
 */
const LONG_OPTS = { maxBuffer: 20 * 1024 * 1024 };

function npmInstall(projectPath, deployUser) {
  return shell.runAsUser(deployUser, 'npm install', { cwd: projectPath, ...LONG_OPTS });
}

function prismaGenerate(projectPath, deployUser) {
  return shell.runAsUser(deployUser, 'npx prisma generate', { cwd: projectPath, ...LONG_OPTS });
}

function prismaDbPush(projectPath, deployUser) {
  // --accept-data-loss dihindari sengaja: kalau prisma minta konfirmasi karena
  // ada potensi kehilangan data, biar GAGAL & kelihatan errornya, bukan
  // ke-skip diam-diam.
  return shell.runAsUser(deployUser, 'npx prisma db push', { cwd: projectPath, ...LONG_OPTS });
}

function prismaMigrateDeploy(projectPath, deployUser) {
  return shell.runAsUser(deployUser, 'npx prisma migrate deploy', { cwd: projectPath, ...LONG_OPTS });
}

function prismaSeed(projectPath, deployUser) {
  return shell.runAsUser(deployUser, 'npx prisma db seed', { cwd: projectPath, ...LONG_OPTS });
}

function npmBuild(projectPath, deployUser) {
  return shell.runAsUser(deployUser, 'npm run build', { cwd: projectPath, ...LONG_OPTS });
}

module.exports = {
  hasPrismaSchema,
  hasPackageJson,
  npmInstall,
  prismaGenerate,
  prismaDbPush,
  prismaMigrateDeploy,
  prismaSeed,
  npmBuild,
};
