import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { rebuildSingleModule } = require('../../../scripts/rebuildNativeModules.js') as {
  rebuildSingleModule: (options: Record<string, unknown>) => boolean;
};

describe('rebuildSingleModule', () => {
  it('skips the rebuild when the module ships an N-API prebuild for the target', () => {
    const moduleRoot = mkdtempSync(path.join(os.tmpdir(), 'napi-prebuild-'));
    mkdirSync(path.join(moduleRoot, 'prebuilds'));
    writeFileSync(path.join(moduleRoot, 'prebuilds', 'win32-x64.node'), '');

    const ok = rebuildSingleModule({
      moduleName: 'better-sqlite3',
      moduleRoot,
      platform: 'win32',
      arch: 'x64',
      electronVersion: '44.9.1',
      buildArch: 'arm64',
    });

    expect(ok).toBe(true);
  });
});
