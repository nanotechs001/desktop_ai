/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * `setPetNotifyHook` is a no-op: bridge events never reach a pet hook.
 */

import { describe, expect, it, vi } from 'vitest';

const adapter = vi.hoisted(() => ({
  emit: undefined as undefined | ((name: string, data: unknown) => void),
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('@/common/platform/bridge', () => ({
  bridge: {
    adapter: (impl: { emit: (name: string, data: unknown) => void }) => {
      adapter.emit = impl.emit;
    },
  },
}));
vi.mock('@/common/adapter/registry', () => ({
  registerWebSocketBroadcaster: vi.fn(),
  getBridgeEmitter: vi.fn(),
  setBridgeEmitter: vi.fn(),
  broadcastToAll: vi.fn(),
}));

import { setPetNotifyHook } from '@/common/adapter/main';

describe('setPetNotifyHook', () => {
  it('never calls the hook when a bridge event is emitted', () => {
    const hook = vi.fn();
    setPetNotifyHook(hook);

    expect(adapter.emit).toBeTypeOf('function');
    adapter.emit?.('conversation.responseStream', { text: 'hi' });

    expect(hook).not.toHaveBeenCalled();
  });

  it('accepts null to clear the hook', () => {
    expect(() => setPetNotifyHook(null)).not.toThrow();
  });
});
