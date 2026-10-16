/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type Provider = (request: unknown) => Promise<{ success: boolean; data?: unknown; msg?: string }>;

const ipc = vi.hoisted(() => {
  const providers = new Map<string, Provider>();
  const provider = (name: string) => ({ provider: (fn: Provider) => providers.set(name, fn) });
  return {
    providers,
    ensureBrowserSession: vi.fn(),
    bridge: {
      browser: {
        profilePartition: provider('profilePartition'),
        clearProfileData: provider('clearProfileData'),
        deleteProfileData: provider('deleteProfileData'),
      },
    },
  };
});
vi.mock('@/common', () => ({ ipcBridge: ipc.bridge }));
vi.mock('electron', () => ({ app: { getPath: () => '/u' }, session: { fromPartition: vi.fn() } }));
vi.mock('@process/services/browserSession/browserSession', () => ({
  ensureBrowserSession: ipc.ensureBrowserSession,
  browserExtensionsSettled: () => Promise.resolve(),
}));

import { registerBrowserProfileIpc } from '@process/services/browserSession/profiles/profileIpc';
import {
  agentPartition,
  deleteAgentBrowserData,
  parseBrowserTabProfile,
  partitionOfProfile,
  profileOfPartition,
} from '@process/services/browserSession/profiles/browserProfiles';

const USER_DATA = path.join(path.sep, 'tmp', 'aionui-user-data');

const fakeSession = (storagePath: string | null) => {
  const steps: string[] = [];
  return {
    steps,
    session: {
      storagePath,
      clearStorageData: vi.fn(async () => {
        steps.push('clearStorageData');
      }),
      clearCache: vi.fn(async () => {
        steps.push('clearCache');
      }),
      clearAuthCache: vi.fn(async () => {
        steps.push('clearAuthCache');
      }),
    },
  };
};

describe('agentPartition', () => {
  it('is persist:aionui-agent- plus the first 32 hex chars of sha256(agentId), the same every time', () => {
    const hash = createHash('sha256').update('bare:632f31d2').digest('hex').slice(0, 32);

    expect(agentPartition('bare:632f31d2')).toBe(`persist:aionui-agent-${hash}`);
    expect(agentPartition('bare:632f31d2')).toBe(agentPartition('bare:632f31d2'));
    expect(agentPartition('aion-default-agent')).not.toBe(agentPartition('bare:632f31d2'));
  });

  it('agentPartition rejects ids with other characters', () => {
    for (const bad of ['', 'a b', '../x', 'a/b', 'a\\b', 'é', 'a\nb', 'x'.repeat(129)]) {
      expect(() => agentPartition(bad), JSON.stringify(bad)).toThrow();
    }
    expect(() => agentPartition('x'.repeat(128))).not.toThrow();
  });

  it('maps a computed partition back to its Agent, in memory, and Personal to its own partition', () => {
    const partition = agentPartition('bare:abc');

    expect(profileOfPartition(partition)).toEqual({ kind: 'agent', agentId: 'bare:abc' });
    expect(profileOfPartition('persist:aionui-browser')).toEqual({ kind: 'personal' });
    expect(profileOfPartition('persist:aionui-agent-ffffffffffffffffffffffffffffffff')).toBeNull();
    expect(partitionOfProfile({ kind: 'personal' })).toBe('persist:aionui-browser');
    expect(partitionOfProfile({ kind: 'agent', agentId: 'bare:abc' })).toBe(partition);
  });
});

describe('parseBrowserTabProfile', () => {
  it('accepts only a well-formed profile', () => {
    expect(parseBrowserTabProfile({ kind: 'personal' })).toEqual({ kind: 'personal' });
    expect(parseBrowserTabProfile({ kind: 'agent', agentId: 'bare:1', extra: true })).toEqual({
      kind: 'agent',
      agentId: 'bare:1',
    });
    for (const bad of [null, 'personal', {}, { kind: 'agent' }, { kind: 'agent', agentId: 'a b' }, { kind: 'x' }]) {
      expect(parseBrowserTabProfile(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('deleteAgentBrowserData', () => {
  it('deleting an Agent with "delete browser data" clears its storage and removes the partition folder', async () => {
    const partition = agentPartition('bare:gone');
    const folder = path.join(USER_DATA, 'Partitions', partition.slice('persist:'.length));
    const { session, steps } = fakeSession(folder);
    const fromPartition = vi.fn(() => session);
    const removeDir = vi.fn(async (dir: string) => {
      steps.push(`rm ${dir}`);
    });

    await deleteAgentBrowserData('bare:gone', { userDataDir: USER_DATA, fromPartition, removeDir });

    expect(fromPartition).toHaveBeenCalledWith(partition);
    expect(steps).toEqual(['clearStorageData', 'clearCache', 'clearAuthCache', `rm ${folder}`]);
  });

  it('never removes a folder that is not exactly the partition folder under userData/Partitions', async () => {
    for (const storagePath of [null, USER_DATA, path.join(USER_DATA, 'Partitions'), path.join(USER_DATA, 'other')]) {
      const { session } = fakeSession(storagePath);
      const removeDir = vi.fn(async () => {});

      await expect(
        deleteAgentBrowserData('bare:gone', { userDataDir: USER_DATA, fromPartition: () => session, removeDir })
      ).rejects.toThrow();
      expect(removeDir).not.toHaveBeenCalled();
    }
  });

  it('rejects a bad Agent id before touching any session', async () => {
    const fromPartition = vi.fn();
    const removeDir = vi.fn();

    await expect(
      deleteAgentBrowserData('../../etc', { userDataDir: USER_DATA, fromPartition, removeDir })
    ).rejects.toThrow();
    expect(fromPartition).not.toHaveBeenCalled();
    expect(removeDir).not.toHaveBeenCalled();
  });
});

describe('the browser-profile IPC', () => {
  registerBrowserProfileIpc();
  const call = (name: string, request: unknown) => (ipc.providers.get(name) as Provider)(request);

  it("sets an Agent profile's session up before answering with its partition", async () => {
    const reply = await call('profilePartition', { kind: 'agent', agentId: 'bare:ipc' });

    expect(reply).toEqual({ success: true, data: agentPartition('bare:ipc') });
    expect(ipc.ensureBrowserSession).toHaveBeenCalledWith(agentPartition('bare:ipc'));
  });

  it('refuses a malformed profile or Agent id without touching any session', async () => {
    ipc.ensureBrowserSession.mockClear();
    for (const bad of [null, { kind: 'agent', agentId: '../x' }, { kind: 'other' }]) {
      expect((await call('profilePartition', bad)).success).toBe(false);
    }
    expect((await call('clearProfileData', { agentId: 7 })).success).toBe(false);
    expect((await call('deleteProfileData', {})).success).toBe(false);
    expect(ipc.ensureBrowserSession).not.toHaveBeenCalled();
  });
});
