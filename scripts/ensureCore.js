/**
 * Runs before `bun run dev`: rebuilds core/target/release/aioncore when anything in core/ (Rust sources, the
 * built-in skills compiled into it) is newer than the binary, so a `git pull` never leaves the app on a stale backend.
 *
 * Skipped when there is no local build yet (dev then falls back to the bundled or PATH binary, as before) and when
 * AIONUI_BACKEND_BIN points at a different binary.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const coreDir = path.join(root, 'core');
const binaryPath = path.join(coreDir, 'target', 'release', process.platform === 'win32' ? 'aioncore.exe' : 'aioncore');
const SKIPPED_DIRS = new Set(['target', '.git', 'node_modules']);

function hasNewerFile(dir, since) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name) && hasNewerFile(full, since)) return true;
    } else if (entry.isFile() && fs.statSync(full).mtimeMs > since) {
      return true;
    }
  }
  return false;
}

/** True when the binary exists and some file under coreDir (outside build output) changed after it was built. */
function isCoreStale(dir, binary) {
  if (!fs.existsSync(binary)) return false;
  return hasNewerFile(dir, fs.statSync(binary).mtimeMs);
}

function main() {
  const override = process.env.AIONUI_BACKEND_BIN?.trim();
  if (override && path.resolve(override) !== binaryPath) return;
  if (!isCoreStale(coreDir, binaryPath)) return;

  console.log('[ensureCore] core/ changed since aioncore was built; rebuilding (bun run core:build)...');
  const result = spawnSync(process.execPath, [path.join(__dirname, 'buildCore.js')], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('[ensureCore] aioncore rebuild failed; fix the build above or run `bun run core:build`.');
    process.exit(result.status ?? 1);
  }
  // Cargo leaves the binary untouched when only non-code files changed; mark it current so the next start skips.
  const now = new Date();
  fs.utimesSync(binaryPath, now, now);
}

if (require.main === module) main();

module.exports = { isCoreStale };
