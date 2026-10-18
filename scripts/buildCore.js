/**
 * Builds the backend in core/ (release) for local runs: `bun run core:build`.
 * The app then picks up core/target/release/aioncore automatically (see process/backend/binaryResolver.ts).
 *
 * Cargo is taken from ~/.cargo/bin when it is not on PATH. On Windows the MSVC linker needs the
 * Visual Studio build environment, so vcvars64.bat is located with vswhere and loaded first.
 */
const { execFileSync, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cargoArgs = ['build', '--release', '--manifest-path', path.join(root, 'core', 'Cargo.toml'), '-p', 'aionui-app'];
const env = { ...process.env, PATH: `${path.join(os.homedir(), '.cargo', 'bin')}${path.delimiter}${process.env.PATH}` };

function windowsBuild() {
  const vswhere = path.join(
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe'
  );
  const install = execFileSync(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ])
    .toString()
    .trim();
  if (!install) throw new Error('Visual Studio C++ build tools not found (needed to link the backend on Windows).');
  const vcvars = path.join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  const command = `call "${vcvars}" >nul && cargo ${cargoArgs.map((a) => `"${a}"`).join(' ')}`;
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `"${command}"`], {
    stdio: 'inherit',
    env,
    windowsVerbatimArguments: true,
  });
}

const result = process.platform === 'win32' ? windowsBuild() : spawnSync('cargo', cargoArgs, { stdio: 'inherit', env });
process.exit(result.status ?? 1);
