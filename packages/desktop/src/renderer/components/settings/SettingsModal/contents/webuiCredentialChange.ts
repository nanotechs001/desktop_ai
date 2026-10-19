/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Run a WebUI password/username change, then sign out the other devices.
 * A failed change rejects before anything is revoked. A failed revoke is logged and
 * reported through `onRevokeFailed`, but the change still counts as done.
 */
export async function changeWebuiCredential<T>(
  change: () => Promise<T>,
  revokeOtherSessions: () => Promise<void>,
  onRevokeFailed: () => void
): Promise<T> {
  const result = await change();
  try {
    await revokeOtherSessions();
  } catch (error) {
    console.error('[WebuiModal] Failed to sign out other devices:', error);
    onRevokeFailed();
  }
  return result;
}
