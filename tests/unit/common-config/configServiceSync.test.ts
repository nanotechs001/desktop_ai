/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every renderer window (main, each robot) has its own settings cache: a write announces itself so the other windows
 * can follow, and a read-modify-write can re-read the stored values first so no other window's change is lost.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@/common/config/configService';

let backend: Record<string, unknown> = {};
const fetchMock = vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
  if (init?.method === 'PUT') backend = { ...backend, ...(JSON.parse(init.body ?? '{}') as Record<string, unknown>) };
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ data: init?.method === 'PUT' ? null : backend }),
    text: async () => '',
  };
});

beforeEach(() => {
  backend = { 'agent.enginePins': { a: 'claude' }, 'agent.colors': { a: '#3e63dd' } };
  vi.stubGlobal('fetch', fetchMock);
  configService.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
});

describe('configService across windows', () => {
  it('announces each stored write, never a local-only one', async () => {
    const writes: Array<Record<string, unknown>> = [];
    const off = configService.onWrite((entries) => writes.push(entries));

    await configService.set('agent.enginePins', { a: 'codex' });
    await configService.remove('agent.colors');
    configService.setLocal('agent.enginePins', { a: 'local' });
    off();
    await configService.set('agent.enginePins', { a: 'after' });

    expect(writes).toEqual([{ 'agent.enginePins': { a: 'codex' } }, { 'agent.colors': null }]);
  });

  it('applies what another window stored to this cache and its subscribers, without writing it again', () => {
    const seen: unknown[] = [];
    configService.subscribe('agent.enginePins', (value) => seen.push(value));

    configService.applyRemote({ 'agent.enginePins': { b: 'codex' }, 'agent.colors': null });

    expect(configService.get('agent.enginePins')).toEqual({ b: 'codex' });
    expect(configService.get('agent.colors')).toBeUndefined();
    expect(seen).toEqual([{ b: 'codex' }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-reads only the given keys from the stored settings', async () => {
    await configService.initialize();
    configService.setLocal('agent.colors', { a: '#000000' });
    backend = { ...backend, 'agent.enginePins': { a: 'claude', b: 'codex' }, 'agent.colors': { a: '#ffffff' } };

    await configService.reload(['agent.enginePins']);

    expect(configService.get('agent.enginePins')).toEqual({ a: 'claude', b: 'codex' });
    expect(configService.get('agent.colors')).toEqual({ a: '#000000' });
  });
});
