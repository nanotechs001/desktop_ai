/**
 * Bundles the backend built from this repo's core/ for packaging, instead of downloading the
 * stock AionCore release. Run by build-with-builder.js; also usable on its own:
 * `node scripts/prepareLocalCore.js`.
 *
 * Output (same layout prepare-aioncore.js produces): resources/bundled-aioncore/{platform}-{arch}/
 *   - aioncore[.exe]           release build of core/ (`scripts/buildCore.js`)
 *   - managed-resources/...    `aioncore prepare-managed-resources` (bundled Node runtime etc.)
 *   - manifest.json            sourceType "local-core"
 *
 * The backend is compiled for the host only, so the target platform/arch must match the machine
 * running the build. Set AIONUI_BACKEND_SOURCE=release to use the stock download instead.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  prepareManagedResources,
  verifyPreparedAioncoreBundle,
} = require('../packages/shared-scripts/src/prepare-aioncore.js');

function readCoreVersion(projectRoot) {
  const cargoToml = fs.readFileSync(path.join(projectRoot, 'core', 'Cargo.toml'), 'utf-8');
  const workspacePackage = cargoToml.split(/^\[workspace\.package\]\s*$/m)[1] || '';
  const version = workspacePackage.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  return version ? `v${version}` : 'local';
}

/**
 * @param {object} options
 * @param {string} options.projectRoot - Repo root (contains core/)
 * @param {string} [options.platform] - Target platform (must be the host's)
 * @param {string} [options.arch] - Target architecture (must be the host's)
 * @returns {{ prepared: true; dir: string; sourceType: 'local-core' }}
 */
function prepareLocalCore({ projectRoot, platform = process.platform, arch = process.arch }) {
  const runtimeKey = `${platform}-${arch}`;
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `core/ is built for the host (${process.platform}-${process.arch}) and cannot target ${runtimeKey}. ` +
        'Build on a matching machine, or set AIONUI_BACKEND_SOURCE=release to bundle the stock AionCore download.'
    );
  }

  console.log(`Preparing aioncore for ${runtimeKey} from core/ (local build)`);
  const build = spawnSync(process.execPath, [path.join(__dirname, 'buildCore.js')], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    throw new Error(`core/ build failed (exit ${build.status ?? build.signal})`);
  }

  const binaryName = platform === 'win32' ? 'aioncore.exe' : 'aioncore';
  const builtBinary = path.join(projectRoot, 'core', 'target', 'release', binaryName);
  if (!fs.existsSync(builtBinary)) {
    throw new Error(`core/ build finished but ${builtBinary} is missing`);
  }

  const targetDir = path.join(projectRoot, 'resources', 'bundled-aioncore', runtimeKey);
  const targetBinary = path.join(targetDir, binaryName);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(builtBinary, targetBinary);
  if (platform !== 'win32') fs.chmodSync(targetBinary, 0o755);

  prepareManagedResources(targetBinary, targetDir);

  const manifest = {
    platform,
    arch,
    version: readCoreVersion(projectRoot),
    generatedAt: new Date().toISOString(),
    sourceType: 'local-core',
    source: { path: 'core/' },
    files: [binaryName, 'managed-resources/'],
  };
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  verifyPreparedAioncoreBundle(projectRoot, platform, arch);
  console.log(
    `  Bundled aioncore prepared: resources/bundled-aioncore/${runtimeKey}/${binaryName} [source=local-core]`
  );
  return { prepared: true, dir: targetDir, sourceType: 'local-core' };
}

module.exports = { prepareLocalCore, readCoreVersion };

if (require.main === module) {
  try {
    prepareLocalCore({
      projectRoot: path.resolve(__dirname, '..'),
      arch: process.env.AIONUI_BACKEND_ARCH || process.arch,
    });
  } catch (error) {
    console.error('❌ prepareLocalCore failed:', error.message);
    process.exit(1);
  }
}
