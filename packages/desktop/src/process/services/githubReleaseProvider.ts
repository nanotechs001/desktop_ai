/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UpdateInfo } from 'electron-updater';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider';
import { resolveFiles as resolveProviderFiles } from 'electron-updater/out/providers/Provider';
import { getChannelFilename, newUrlFromBase } from 'electron-updater/out/util';
import log from 'electron-log';

type GenericProviderConfiguration = ConstructorParameters<typeof GenericProvider>[0];
type GenericProviderUpdater = ConstructorParameters<typeof GenericProvider>[1];
type GenericProviderRuntimeOptions = ConstructorParameters<typeof GenericProvider>[2];

export type GitHubReleaseProviderConfiguration = Omit<GenericProviderConfiguration, 'provider'> & {
  provider: 'custom';
  /** Releases page of the repo, e.g. `https://github.com/owner/repo/releases`. */
  url: string;
  updateProvider?: unknown;
};

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * electron-updater provider that reads GitHub release assets by their fixed URLs:
 * - channel file (e.g. `latest.yml`): `{releases}/latest/download/{channelFile}`
 * - update files: `{releases}/download/v{version}/{file}`
 *
 * Unlike the built-in `github` provider it needs no API call or atom feed to find the
 * latest release, and it keeps our per-arch channel names (`latest-arm64`, ...), which
 * the built-in provider misreads as prerelease identifiers. `latest/download` only
 * points at the newest non-prerelease release, so this feed is stable-only.
 */
export class GitHubReleaseProvider extends GenericProvider {
  private readonly _releasesUrl: string;
  private readonly _channelBaseUrl: URL;
  // Parent stores `updater` privately; keep our own reference to rebuild the
  // channel-file URL for logging (the base `channel` getter is also private).
  private readonly _updater: GenericProviderUpdater;

  constructor(
    configuration: GitHubReleaseProviderConfiguration,
    updater: GenericProviderUpdater,
    runtimeOptions: GenericProviderRuntimeOptions
  ) {
    const releasesUrl = withoutTrailingSlash(configuration.url);
    const genericConfiguration: GenericProviderConfiguration = {
      ...configuration,
      provider: 'generic',
      // GenericProvider fetches the channel file relative to this base.
      url: `${releasesUrl}/latest/download/`,
    };
    super(genericConfiguration, updater, runtimeOptions);
    this._updater = updater;
    this._releasesUrl = releasesUrl;
    this._channelBaseUrl = new URL(genericConfiguration.url);
    log.debug('[auto-update] GitHub release provider initialized', {
      releasesUrl,
      platform: runtimeOptions.platform,
      isUseMultipleRangeRequest: runtimeOptions.isUseMultipleRangeRequest,
    });
  }

  /**
   * Resolve the channel metadata file (e.g. `latest-mac.yml`) the updater fetches
   * to discover the newest version. Mirrors GenericProvider's private `channel`
   * getter, which is not accessible from a subclass.
   */
  private resolveLatestVersionUrl(): URL {
    const channelName = this._updater.channel ?? this.getDefaultChannelName();
    const channelFile = getChannelFilename(channelName);
    // `isAddNoCacheQuery` is a real getter on AppUpdater but absent from its public types.
    const addNoCacheQuery = Boolean((this._updater as unknown as { isAddNoCacheQuery?: boolean }).isAddNoCacheQuery);
    return newUrlFromBase(channelFile, this._channelBaseUrl, addNoCacheQuery);
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    log.info('[auto-update] Checking latest version from URL:', this.resolveLatestVersionUrl().href);
    return super.getLatestVersion();
  }

  override resolveFiles(updateInfo: UpdateInfo): ReturnType<GenericProvider['resolveFiles']> {
    const tagBase = `${this._releasesUrl}/download/v${updateInfo.version}/`;
    // An absolute URL wins over the base in newUrlFromBase, so the transformer decides the location.
    const resolved = resolveProviderFiles(updateInfo, this._channelBaseUrl, (filePath) =>
      new URL(filePath, tagBase).toString()
    );
    log.info('[auto-update] Update download URL(s) resolved:', {
      version: updateInfo.version,
      files: resolved.map((file) => file.url.href),
      packages: resolved.map((file) => file.packageInfo?.path).filter(Boolean),
    });
    return resolved;
  }
}
