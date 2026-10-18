/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    getVersion: vi.fn(() => '2.1.40'),
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

vi.mock('@process/services/i18n', () => ({
  default: { t: (key: string) => key },
}));

// The fixtures below are mac-arm64 assets and both resolveChannelFile and
// pickRecommendedAsset read the host platform/arch, so pin the runtime to keep
// results identical on every CI runner (linux/windows x64 would otherwise
// filter the assets out and pick no recommended asset).
import { afterAll, beforeAll } from 'vitest';

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

const RELEASES = 'https://github.com/nanotechs001/desktop_ai/releases';
const LATEST_MANIFEST_URL = `${RELEASES}/latest/download/latest-arm64-mac.yml`;

const channelYml = (version: string) => `version: ${version}
files:
  - url: Pixebot-Browser-${version}-mac-arm64.zip
    size: 100
  - url: Pixebot-Browser-${version}-mac-arm64.dmg
    size: 200
path: Pixebot-Browser-${version}-mac-arm64.zip
releaseDate: '2026-07-31T14:45:19.381Z'
`;

const makeRelease = (tag: string, overrides: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: tag,
  body: `notes for ${tag}`,
  html_url: `${RELEASES}/tag/${tag}`,
  prerelease: false,
  draft: false,
  assets: [],
  ...overrides,
});

const GITHUB_RELEASES = [makeRelease('v2.1.45')];

const getCheckHandler = async () => {
  vi.resetModules();
  const { initUpdateBridge } = await import('@process/bridge/updateBridge');
  const { ipcBridge } = await import('@/common');
  initUpdateBridge();
  const provider = vi.mocked(ipcBridge.update.check.provider);
  const lastCall = provider.mock.calls.at(-1);
  if (!lastCall) throw new Error('update.check handler not registered');
  return lastCall[0];
};

type Responder = () => Promise<Response> | Response;

/** Route fetches: `manifests` keyed by full channel-file URL (others 404), `github` for the releases API. */
const stubFetch = (scenario: { manifests?: Record<string, Responder>; github?: Responder }) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/')) {
      if (!scenario.github) throw new Error('github unreachable');
      return scenario.github();
    }
    if (url.startsWith(`${RELEASES}/`)) {
      const responder = scenario.manifests?.[url];
      return responder ? responder() : new Response('Not Found', { status: 404 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const ymlResponse = (body: string) => new Response(body, { status: 200 });
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('update.check against GitHub releases (stable)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports an update from the latest release manifest and attaches GitHub notes', async () => {
    const fetchMock = stubFetch({
      manifests: { [LATEST_MANIFEST_URL]: () => ymlResponse(channelYml('2.1.45')) },
      github: () => jsonResponse(GITHUB_RELEASES),
    });
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(true);
    expect(res.data?.latest?.version).toBe('2.1.45');
    expect(res.data?.latest?.body).toBe('notes for v2.1.45');
    expect(res.data?.latest?.htmlUrl).toBe(`${RELEASES}/tag/v2.1.45`);
    expect(res.data?.latest?.recommendedAsset?.url).toBe(
      `${RELEASES}/download/v2.1.45/Pixebot-Browser-2.1.45-mac-arm64.dmg`
    );
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toContain(LATEST_MANIFEST_URL);
    expect(urls.some((url) => url.includes('static.aionui.com') || url.includes('iOfficeAI'))).toBe(false);
  });

  it('reports up to date (not an error) while the repo has no release yet', async () => {
    stubFetch({ github: () => jsonResponse([]) });
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(false);
    expect(res.data?.latest).toBeUndefined();
  });

  it('succeeds without notes when the GitHub API is unreachable', async () => {
    stubFetch({ manifests: { [LATEST_MANIFEST_URL]: () => ymlResponse(channelYml('2.1.45')) } });
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(true);
    expect(res.data?.latest?.body).toBeUndefined();
    expect(res.data?.latest?.htmlUrl).toBe('');
    expect(res.data?.latest?.assets.length).toBeGreaterThan(0);
  });

  it('ignores GitHub releases that do not match the manifest version', async () => {
    stubFetch({
      manifests: { [LATEST_MANIFEST_URL]: () => ymlResponse(channelYml('2.1.45')) },
      github: () => jsonResponse([makeRelease('v9.9.9')]),
    });
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data?.latest?.body).toBeUndefined();
  });

  it('reports up-to-date when the release version equals the current version', async () => {
    stubFetch({
      manifests: { [LATEST_MANIFEST_URL]: () => ymlResponse(channelYml('2.1.40')) },
      github: () => jsonResponse([]),
    });
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(false);
  });

  it('fails the check when the manifest request fails with a server error', async () => {
    stubFetch({
      manifests: { [LATEST_MANIFEST_URL]: () => new Response('nope', { status: 502 }) },
      github: () => jsonResponse(GITHUB_RELEASES),
    });
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(false);
  });

  it('fails the check when the manifest is malformed', async () => {
    stubFetch({
      manifests: { [LATEST_MANIFEST_URL]: () => ymlResponse('not: [valid') },
      github: () => jsonResponse(GITHUB_RELEASES),
    });
    const handler = await getCheckHandler();
    const res = await handler({});
    expect(res.success).toBe(false);
  });
});

describe('update.check against GitHub releases (prerelease enabled)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers the newest prerelease, reading its manifest from the release tag', async () => {
    const tag = 'v2.2.0-beta.1';
    stubFetch({
      manifests: {
        [`${RELEASES}/download/${tag}/latest-arm64-mac.yml`]: () => ymlResponse(channelYml('2.2.0-beta.1')),
      },
      github: () =>
        jsonResponse([
          makeRelease(tag, { prerelease: true }),
          makeRelease('v2.1.45'),
          makeRelease('v3.0.0', { draft: true }),
        ]),
    });
    const handler = await getCheckHandler();
    const res = await handler({ includePrerelease: true });
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(true);
    expect(res.data?.latest?.version).toBe('2.2.0-beta.1');
    expect(res.data?.latest?.tagName).toBe(tag);
    expect(res.data?.latest?.prerelease).toBe(true);
    expect(res.data?.latest?.body).toBe(`notes for ${tag}`);
    expect(res.data?.latest?.recommendedAsset?.url).toBe(
      `${RELEASES}/download/${tag}/Pixebot-Browser-2.2.0-beta.1-mac-arm64.dmg`
    );
  });

  it('reports up to date when the repo has no releases', async () => {
    stubFetch({ github: () => jsonResponse([]) });
    const handler = await getCheckHandler();
    const res = await handler({ includePrerelease: true });
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(false);
  });

  it('reports up to date when the newest release has no build for this platform', async () => {
    stubFetch({ github: () => jsonResponse([makeRelease('v2.2.0', { prerelease: true })]) });
    const handler = await getCheckHandler();
    const res = await handler({ includePrerelease: true });
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(false);
  });

  it('falls back to the stable release when the GitHub API is unreachable', async () => {
    stubFetch({ manifests: { [LATEST_MANIFEST_URL]: () => ymlResponse(channelYml('2.1.45')) } });
    const handler = await getCheckHandler();
    const res = await handler({ includePrerelease: true });
    expect(res.success).toBe(true);
    expect(res.data?.updateAvailable).toBe(true);
    expect(res.data?.latest?.version).toBe('2.1.45');
    expect(res.data?.latest?.prerelease).toBe(false);
  });
});
