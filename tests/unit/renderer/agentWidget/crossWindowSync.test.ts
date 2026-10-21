/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * A save in one window (the robot's embedded Agent editor, say) reaches the others: the settings it stored and the
 * Agents list it changed. Without this, the next write from a stale window drops the other window's change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  broadcastConfig: vi.fn(async (_p: unknown) => undefined),
  broadcastAssistantsChanged: vi.fn(async (_p: unknown) => undefined),
  configChanged: [] as Array<(event: { origin: string; entries: Record<string, unknown> }) => void>,
  assistantsChanged: [] as Array<(event: { origin: string }) => void>,
  mutate: vi.fn(async () => undefined),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentWidget: {
      broadcastConfig: { invoke: h.broadcastConfig },
      broadcastAssistantsChanged: { invoke: h.broadcastAssistantsChanged },
      configChanged: {
        on: (fn: (typeof h.configChanged)[number]) => {
          h.configChanged.push(fn);
          return () => h.configChanged.splice(h.configChanged.indexOf(fn), 1);
        },
      },
      assistantsChanged: {
        on: (fn: (typeof h.assistantsChanged)[number]) => {
          h.assistantsChanged.push(fn);
          return () => h.assistantsChanged.splice(h.assistantsChanged.indexOf(fn), 1);
        },
      },
    },
  },
}));
vi.mock('swr', () => ({ mutate: h.mutate }));

import { configService } from '@/common/config/configService';
import { afterAssistantsChanged, installCrossWindowSync } from '@/renderer/services/crossWindowSync';

let uninstall: () => void = () => {};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, headers: { get: () => '' }, text: async () => '' }))
  );
  configService.reset();
  uninstall = installCrossWindowSync();
});

afterEach(() => {
  uninstall();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('cross-window sync', () => {
  it('announces a stored setting to the other windows', async () => {
    await configService.set('agent.enginePins', { bot: 'codex' });
    expect(h.broadcastConfig).toHaveBeenCalledWith({
      origin: expect.any(String),
      entries: { 'agent.enginePins': { bot: 'codex' } },
    });
  });

  it("applies another window's settings, and ignores its own echo", async () => {
    await configService.set('agent.enginePins', { mine: 'claude' });
    const origin = (h.broadcastConfig.mock.calls[0][0] as { origin: string }).origin;

    for (const fn of h.configChanged) fn({ origin, entries: { 'agent.enginePins': { stale: 'echo' } } });
    expect(configService.get('agent.enginePins')).toEqual({ mine: 'claude' });

    for (const fn of h.configChanged) fn({ origin: 'robot-window', entries: { 'agent.enginePins': { bot: 'codex' } } });
    expect(configService.get('agent.enginePins')).toEqual({ bot: 'codex' });
  });

  it("refreshes the Agents list when another window changed it, not on this window's own news", () => {
    afterAssistantsChanged();
    const origin = (h.broadcastAssistantsChanged.mock.calls[0][0] as { origin: string }).origin;

    for (const fn of h.assistantsChanged) fn({ origin });
    expect(h.mutate).not.toHaveBeenCalled();

    for (const fn of h.assistantsChanged) fn({ origin: 'robot-window' });
    expect(h.mutate).toHaveBeenCalledWith('assistants.list');
  });
});
