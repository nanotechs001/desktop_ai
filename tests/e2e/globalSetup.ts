/**
 * Runs once before the e2e suite.
 *
 * 1. Refuses to start when a dev app's CLI-safe data links (~/.aionui-dev*, ~/.aionui-config-dev*) point anywhere but
 *    their own Application Support dirs: an earlier run (or anything else) moved a dev app's data dir, and running on
 *    would hide that. The app no longer touches these links under e2e (ensureCliSafeSymlink).
 * 2. Builds the built-in MCP servers into out/main: `bun run package` (a production electron-vite build) empties
 *    out/main and does not emit them, and the agent-browser spec spawns out/main/builtin-mcp-browser.js.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Each dev link and the only target it may have. */
const expectedLinks = (): [string, string][] => {
  const support = path.join(os.homedir(), 'Library', 'Application Support');
  return (['AionUi-Dev', 'AionUi-Dev-2'] as const).flatMap((app): [string, string][] => {
    const suffix = app === 'AionUi-Dev' ? '-dev' : '-dev-2';
    return [
      [path.join(os.homedir(), `.aionui${suffix}`), path.join(support, app, 'aionui')],
      [path.join(os.homedir(), `.aionui-config${suffix}`), path.join(support, app, 'config')],
    ];
  });
};

const assertDevLinksIntact = (): void => {
  const wrong = expectedLinks().flatMap(([link, target]) => {
    const isLink = fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
    const actual = isLink ? fs.readlinkSync(link) : null;
    return actual !== null && actual !== target ? [`${link} -> ${actual} (expected ${target})`] : [];
  });
  if (wrong.length > 0) {
    throw new Error(`Dev data links point elsewhere; fix them before running e2e:\n${wrong.join('\n')}`);
  }
};

export default function globalSetup(): void {
  assertDevLinksIntact();
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-mcp-servers.js')], { cwd: ROOT, stdio: 'inherit' });
}
