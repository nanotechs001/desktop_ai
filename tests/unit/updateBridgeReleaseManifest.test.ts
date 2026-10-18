/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/common/platform/bridge', () => ({
  bridge: {
    buildProvider: vi.fn(() => {
      const handlerMap = new Map<string, Function>();
      return {
        provider: vi.fn((handler: Function) => {
          handlerMap.set('handler', handler);
          return vi.fn();
        }),
        invoke: vi.fn(),
        _getHandler: () => handlerMap.get('handler'),
      };
    }),
    buildEmitter: vi.fn(() => ({
      emit: vi.fn(),
      on: vi.fn(),
    })),
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/test/path'),
    exit: vi.fn(),
    isPackaged: true,
  },
  autoUpdater: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    setFeedURL: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } },
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import { afterAll, beforeAll } from 'vitest';
import { mapManifestToRelease, parseChannelManifest, resolveChannelFile } from '@process/bridge/updateBridge';

// The fixtures below are mac-arm64 assets and pickRecommendedAsset scores by
// the host platform/arch, so pin the runtime to keep results identical on
// every CI runner (linux/windows x64 would otherwise filter the assets out).
const realPlatform = process.platform;
const realArch = process.arch;
beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
});

const SAMPLE_YML = `version: 2.1.45
files:
  - url: AionUi-2.1.45-mac-arm64.zip
    sha512: abc==
    size: 474779381
  - url: AionUi-2.1.45-mac-arm64.dmg
    sha512: def==
    size: 469685641
path: AionUi-2.1.45-mac-arm64.zip
sha512: abc==
releaseDate: '2026-07-31T14:45:19.381Z'
`;

describe('resolveChannelFile', () => {
  it.each([
    ['win32', 'x64', 'latest.yml'],
    ['win32', 'arm64', 'latest-win-arm64.yml'],
    ['darwin', 'x64', 'latest-mac.yml'],
    ['darwin', 'arm64', 'latest-arm64-mac.yml'],
    ['linux', 'x64', 'latest-linux.yml'],
    ['linux', 'arm64', 'latest-linux-arm64.yml'],
  ] as const)('%s/%s -> %s', (platform, arch, expected) => {
    expect(resolveChannelFile({ platform: platform as NodeJS.Platform, arch })).toBe(expected);
  });
});

describe('parseChannelManifest', () => {
  it('parses version, files and releaseDate', () => {
    const manifest = parseChannelManifest(SAMPLE_YML);
    expect(manifest).not.toBeNull();
    expect(manifest?.version).toBe('2.1.45');
    expect(manifest?.files).toHaveLength(2);
    expect(manifest?.files[0]).toMatchObject({ url: 'AionUi-2.1.45-mac-arm64.zip', size: 474779381 });
    expect(manifest?.releaseDate).toBe('2026-07-31T14:45:19.381Z');
  });

  it('returns null for invalid yml or missing version/files', () => {
    expect(parseChannelManifest('not: [valid')).toBeNull();
    expect(parseChannelManifest('files: []')).toBeNull();
    expect(parseChannelManifest('version: 1.0.0')).toBeNull();
  });
});

describe('mapManifestToRelease', () => {
  it('maps files to GitHub release asset URLs under the v-prefixed tag', () => {
    const manifest = parseChannelManifest(SAMPLE_YML);
    if (!manifest) throw new Error('manifest should parse');
    const release = mapManifestToRelease(manifest, 'nanotechs001/desktop_ai');
    expect(release).not.toBeNull();
    expect(release?.version).toBe('2.1.45');
    expect(release?.tagName).toBe('v2.1.45');
    expect(release?.prerelease).toBe(false);
    expect(release?.htmlUrl).toBe('');
    expect(release?.publishedAt).toBe('2026-07-31T14:45:19.381Z');
    const dmg = release?.assets.find((a) => a.name.endsWith('.dmg'));
    expect(dmg?.url).toBe(
      'https://github.com/nanotechs001/desktop_ai/releases/download/v2.1.45/AionUi-2.1.45-mac-arm64.dmg'
    );
    expect(dmg?.fallbackUrl).toBeUndefined();
    expect(dmg?.size).toBe(469685641);
    expect(release?.recommendedAsset).toBeDefined();
  });

  it('uses the given release tag and prerelease flag', () => {
    const manifest = parseChannelManifest(SAMPLE_YML);
    if (!manifest) throw new Error('manifest should parse');
    const release = mapManifestToRelease(manifest, 'nanotechs001/desktop_ai', {
      tagName: 'v2.1.45-beta',
      prerelease: true,
    });
    expect(release?.tagName).toBe('v2.1.45-beta');
    expect(release?.prerelease).toBe(true);
    expect(release?.assets[0]?.url).toBe(
      'https://github.com/nanotechs001/desktop_ai/releases/download/v2.1.45-beta/AionUi-2.1.45-mac-arm64.zip'
    );
  });

  it('URL-encodes asset names that contain spaces', () => {
    const release = mapManifestToRelease(
      { version: '2.3.0', files: [{ url: 'Pixebot Browser-2.3.0-win-x64.exe' }] },
      'nanotechs001/desktop_ai'
    );
    expect(release?.assets[0]?.url).toBe(
      'https://github.com/nanotechs001/desktop_ai/releases/download/v2.3.0/Pixebot%20Browser-2.3.0-win-x64.exe'
    );
  });

  it('returns null when version is not valid semver', () => {
    const release = mapManifestToRelease(
      { version: 'not-a-version', files: [{ url: 'a.dmg' }] },
      'nanotechs001/desktop_ai'
    );
    expect(release).toBeNull();
  });
});
