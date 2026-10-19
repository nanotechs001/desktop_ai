/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { changeWebuiCredential } from '@/renderer/components/settings/SettingsModal/contents/webuiCredentialChange';

describe('changeWebuiCredential', () => {
  it('revokes other sessions after a successful change and returns its result', async () => {
    const change = vi.fn().mockResolvedValue({ username: 'bob' });
    const revoke = vi.fn().mockResolvedValue(undefined);
    const onRevokeFailed = vi.fn();
    await expect(changeWebuiCredential(change, revoke, onRevokeFailed)).resolves.toEqual({ username: 'bob' });
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(onRevokeFailed).not.toHaveBeenCalled();
  });

  it('revokes nothing when the change fails', async () => {
    const revoke = vi.fn();
    await expect(changeWebuiCredential(() => Promise.reject(new Error('too short')), revoke, vi.fn())).rejects.toThrow(
      'too short'
    );
    expect(revoke).not.toHaveBeenCalled();
  });

  it('warns and logs, but still resolves, when revoking fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onRevokeFailed = vi.fn();
    const result = await changeWebuiCredential(
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('save failed')),
      onRevokeFailed
    );
    expect(result).toBe('ok');
    expect(onRevokeFailed).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
