/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { APP_GITHUB_REPO } from '@/common/config/constants';
import { GitHubReleaseProvider } from './githubReleaseProvider';
import type { GitHubReleaseProviderConfiguration } from './githubReleaseProvider';

/** Releases page the app updates from; the provider derives channel and asset URLs from it. */
export const UPDATE_RELEASES_URL = `https://github.com/${APP_GITHUB_REPO}/releases`;

export type UpdateFeedOptions = GitHubReleaseProviderConfiguration & {
  updateProvider: typeof GitHubReleaseProvider;
};

export function buildUpdateFeedOptions(): UpdateFeedOptions {
  return {
    provider: 'custom',
    url: UPDATE_RELEASES_URL,
    updateProvider: GitHubReleaseProvider,
  };
}
