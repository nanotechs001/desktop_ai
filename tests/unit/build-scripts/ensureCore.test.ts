import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { isCoreStale } = require('../../../scripts/ensureCore.js') as {
  isCoreStale: (coreDir: string, binaryPath: string) => boolean;
};

const OLD = new Date('2026-01-01T00:00:00Z');
const NEW = new Date('2026-06-01T00:00:00Z');

function makeCore(): { coreDir: string; binary: string; skill: string } {
  const coreDir = mkdtempSync(path.join(os.tmpdir(), 'ensure-core-'));
  const skillDir = path.join(
    coreDir,
    'crates',
    'aionui-app',
    'assets',
    'builtin-skills',
    'auto-inject',
    'page-builder'
  );
  mkdirSync(skillDir, { recursive: true });
  mkdirSync(path.join(coreDir, 'target', 'release'), { recursive: true });
  const skill = path.join(skillDir, 'SKILL.md');
  const binary = path.join(coreDir, 'target', 'release', 'aioncore');
  writeFileSync(skill, '---\nname: page-builder\n---\n');
  writeFileSync(binary, '');
  utimesSync(skill, OLD, OLD);
  utimesSync(binary, OLD, OLD);
  return { coreDir, binary, skill };
}

describe('isCoreStale', () => {
  it('is stale when a built-in skill is newer than the binary', () => {
    const { coreDir, binary, skill } = makeCore();
    utimesSync(skill, NEW, NEW);
    expect(isCoreStale(coreDir, binary)).toBe(true);
  });

  it('is fresh when the binary is newer than every source file', () => {
    const { coreDir, binary } = makeCore();
    utimesSync(binary, NEW, NEW);
    expect(isCoreStale(coreDir, binary)).toBe(false);
  });

  it('ignores build output under target/', () => {
    const { coreDir, binary } = makeCore();
    utimesSync(binary, NEW, NEW);
    const artifact = path.join(coreDir, 'target', 'release', 'deps.d');
    writeFileSync(artifact, '');
    utimesSync(artifact, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'));
    expect(isCoreStale(coreDir, binary)).toBe(false);
  });

  it('is not stale when there is no binary to refresh', () => {
    const { coreDir } = makeCore();
    expect(isCoreStale(coreDir, path.join(coreDir, 'target', 'release', 'missing'))).toBe(false);
  });
});
