/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from 'electron-updater';
import type { AppUpdater } from 'electron-updater/out/AppUpdater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { APP_GITHUB_REPO } from '@/common/config/constants';
import { GitHubReleaseProvider } from '@/process/services/githubReleaseProvider';
import { buildUpdateFeedOptions, UPDATE_RELEASES_URL } from '@/process/services/updateFeed';

const RELEASES_URL = 'https://github.com/nanotechs001/desktop_ai/releases';

const makeRuntimeOptions = (): ProviderRuntimeOptions => ({
  isUseMultipleRangeRequest: true,
  platform: 'darwin',
  executor: {
    request: vi.fn(),
  } as unknown as ProviderRuntimeOptions['executor'],
});

const makeUpdateInfo = (fileName: string): UpdateInfo => ({
  version: '2.3.0',
  files: [{ url: fileName, sha512: 'sha512-value' }],
  path: fileName,
  sha512: 'sha512-value',
  releaseDate: '2026-10-18T00:00:00.000Z',
});

describe('update feed options', () => {
  it("builds a custom electron-updater provider pointed at this project's GitHub releases", () => {
    const options = buildUpdateFeedOptions();

    expect(APP_GITHUB_REPO).toBe('nanotechs001/desktop_ai');
    expect(UPDATE_RELEASES_URL).toBe(RELEASES_URL);
    expect(options.provider).toBe('custom');
    expect(options.url).toBe(RELEASES_URL);
    expect(options.updateProvider).toBe(GitHubReleaseProvider);
  });

  it('never points at the upstream AionUi CDN or repo', () => {
    const { url } = buildUpdateFeedOptions();

    expect(url).not.toContain('static.aionui.com');
    expect(url).not.toContain('iOfficeAI');
  });
});

describe('GitHubReleaseProvider', () => {
  const makeProvider = (url = RELEASES_URL) =>
    new GitHubReleaseProvider({ provider: 'custom', url }, { channel: 'latest' } as AppUpdater, makeRuntimeOptions());

  it('resolves update files under the v-prefixed release tag', () => {
    const files = makeProvider().resolveFiles(makeUpdateInfo('Pixebot-Browser-2.3.0-mac-arm64.zip'));

    expect(files[0]?.url.href).toBe(`${RELEASES_URL}/download/v2.3.0/Pixebot-Browser-2.3.0-mac-arm64.zip`);
  });

  it('tolerates a trailing slash on the releases URL', () => {
    const files = makeProvider(`${RELEASES_URL}/`).resolveFiles(makeUpdateInfo('Pixebot-Browser-2.3.0-win-x64.exe'));

    expect(files[0]?.url.href).toBe(`${RELEASES_URL}/download/v2.3.0/Pixebot-Browser-2.3.0-win-x64.exe`);
  });

  it('reads the channel file from the latest release download URL', async () => {
    const provider = makeProvider();
    const httpRequest = vi
      .spyOn(provider as unknown as { httpRequest: (url: URL) => Promise<string> }, 'httpRequest')
      .mockResolvedValue(
        'version: 2.3.0\nfiles:\n  - url: a.zip\n    sha512: x\npath: a.zip\nsha512: x\nreleaseDate: 2026-10-18\n'
      );

    const info = await provider.getLatestVersion();

    expect(info.version).toBe('2.3.0');
    expect(String(httpRequest.mock.calls[0]?.[0])).toBe(`${RELEASES_URL}/latest/download/latest-mac.yml`);
  });
});
