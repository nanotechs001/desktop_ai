import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPlatformServices } from '@/common/platform';
import type { IPlatformServices } from '@/common/platform/IPlatformServices';
import { getConfigPath, getDataPath } from '@process/utils/utils';

let home: string;
let userData: string;

/** macOS-like paths: CLI-safe symlinks wanted, home and userData in a throwaway dir. */
const registerPaths = (): void => {
  registerPlatformServices({
    paths: {
      getDataDir: () => userData,
      getHomeDir: () => home,
      getTempDir: () => os.tmpdir(),
      needsCliSafeSymlinks: () => true,
      isPackaged: () => false,
    },
  } as unknown as IPlatformServices);
};

describe('CLI-safe data symlinks under e2e', () => {
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-symlink-test-'));
    home = path.join(root, 'home');
    userData = path.join(root, 'userData');
    fs.mkdirSync(home);
    vi.stubEnv('AIONUI_MULTI_INSTANCE', '');
    registerPaths();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  });

  it('links ~/.aionui-dev to the data dir outside e2e', () => {
    vi.stubEnv('AIONUI_E2E_TEST', '');
    vi.stubEnv('AIONUI_E2E_USER_DATA_DIR', '');

    const dataPath = getDataPath();

    expect(fs.lstatSync(dataPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(dataPath)).toBe(path.join(userData, 'aionui'));
  });

  it.each(['AIONUI_E2E_TEST', 'AIONUI_E2E_USER_DATA_DIR'])(
    'never touches home symlinks when %s is set, so a running dev app keeps its data dir',
    (variable) => {
      vi.stubEnv('AIONUI_E2E_TEST', '');
      vi.stubEnv('AIONUI_E2E_USER_DATA_DIR', '');
      vi.stubEnv(variable, variable === 'AIONUI_E2E_TEST' ? '1' : userData);
      const devLink = path.join(home, '.aionui-dev');
      fs.symlinkSync('/somewhere/AionUi-Dev/aionui', devLink);

      expect(getDataPath()).toBe(path.join(userData, 'aionui'));
      expect(getConfigPath()).toBe(path.join(userData, 'config'));
      expect(fs.readlinkSync(devLink)).toBe('/somewhere/AionUi-Dev/aionui');
      expect(fs.readdirSync(home)).toEqual(['.aionui-dev']);
    }
  );
});
