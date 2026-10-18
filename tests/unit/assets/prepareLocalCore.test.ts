import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { prepareLocalCore, readCoreVersion } = require('../../../scripts/prepareLocalCore');

describe('prepareLocalCore', () => {
  it('reads the backend version from the core/ workspace manifest', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'aionui-local-core-'));
    try {
      mkdirSync(join(projectRoot, 'core'));
      writeFileSync(
        join(projectRoot, 'core', 'Cargo.toml'),
        '[workspace]\nmembers = []\n\n[workspace.package]\nedition = "2021"\nversion = "1.2.3"\n'
      );
      expect(readCoreVersion(projectRoot)).toBe('v1.2.3');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('refuses a target that is not the host, before building anything', () => {
    const otherArch = process.arch === 'arm64' ? 'x64' : 'arm64';
    expect(() => prepareLocalCore({ projectRoot: tmpdir(), platform: process.platform, arch: otherArch })).toThrow(
      /AIONUI_BACKEND_SOURCE=release/
    );
  });
});
