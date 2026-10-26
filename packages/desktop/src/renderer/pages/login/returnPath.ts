/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Where sign-in goes when the user came to it on their own. */
const HOME_PATH = '/guid';

/** Router state the sign-in redirect carries: the page the user was on (path and query). */
export type LoginRedirectState = { from: string };

/**
 * The in-app page to return to after sign-in: the one the redirect came from (a chat the user had open when the
 * session expired), else the start page. Only an app path counts, never the login pages or another origin.
 */
export function returnPathOf(state: unknown): string {
  const from = (state as Partial<LoginRedirectState> | null)?.from;
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return HOME_PATH;
  if (/^\/(?:qr-)?login(?:[/?#]|$)/.test(from)) return HOME_PATH;
  return from;
}
