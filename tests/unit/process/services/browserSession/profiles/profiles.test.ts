/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type Provider = (request: unknown) => Promise<{ success: boolean; data?: unknown; msg?: string }>;

const ipc = vi.hoisted(() => {
  const providers = new Map<string, Provider>();
  const provider = (name: string) => ({ provider: (fn: Provider) => providers.set(name, fn) });
  return {
    providers,
    ensureBrowserSession: vi.fn(),
    forgetBrowserSession: vi.fn(),
    forgetPermissions: vi.fn(),
    fromPartition: vi.fn(),
    getAllWebContents: vi.fn((): unknown[] => []),
    profileRemoved: vi.fn(),
    bridge: {
      browser: {
        profileRemoved: { emit: (event: unknown) => ipc.profileRemoved(event) },
        profilePartition: provider('profilePartition'),
        clearProfileData: provider('clearProfileData'),
        deleteProfileData: provider('deleteProfileData'),
        cookieImport: { listSources: provider('cookieImportSources'), run: provider('cookieImportRun') },
      },
    },
  };
});
vi.mock('@/common', () => ({ ipcBridge: ipc.bridge }));
vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA_DIR },
  session: { fromPartition: ipc.fromPartition },
  webContents: { getAllWebContents: ipc.getAllWebContents },
  BrowserWindow: { fromWebContents: () => null },
}));
const USER_DATA_DIR = vi.hoisted(() => '/nonexistent-aionui-test-user-data');
vi.mock('@process/services/browserSession/permissions', () => ({ forgetPermissions: ipc.forgetPermissions }));
vi.mock('@process/services/browserSession/browserSession', () => ({
  ensureBrowserSession: ipc.ensureBrowserSession,
  forgetBrowserSession: ipc.forgetBrowserSession,
  browserExtensionsSettled: () => Promise.resolve(),
}));

import { registerBrowserProfileIpc } from '@process/services/browserSession/profiles/profileIpc';
import {
  agentPartition,
  deleteAgentBrowserData,
  isDeletedAgentProfile,
  onAgentProfileDeleted,
  partitionOfSession,
  rememberBrowserSession,
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
  /** Deps that record each step in `steps`, in order. */
  const recordingDeps = (storagePath: string | null) => {
    const { session, steps } = fakeSession(storagePath);
    return {
      steps,
      session,
      deps: {
        userDataDir: USER_DATA,
        fromPartition: vi.fn(() => session),
        closeLiveContents: vi.fn(async (_session: unknown, profile: unknown) => {
          steps.push(`close ${JSON.stringify(profile)}`);
        }),
        unloadExtensions: vi.fn(() => {
          steps.push('unload extensions');
        }),
        removeDir: vi.fn(async (dir: string) => {
          steps.push(`rm ${dir}`);
        }),
        forgetPartition: vi.fn((partition: string) => {
          steps.push(`forget ${partition}`);
        }),
      },
    };
  };
  const folderOf = (partition: string) => path.join(USER_DATA, 'Partitions', partition.slice('persist:'.length));

  it('deleting an Agent with "delete browser data" closes its pages, unloads extensions, clears, removes the folder, then forgets it', async () => {
    const partition = agentPartition('bare:gone');
    const { deps, steps } = recordingDeps(folderOf(partition));
    const deleted = vi.fn();
    const off = onAgentProfileDeleted(deleted);

    await deleteAgentBrowserData('bare:gone', deps);
    off();

    expect(deps.fromPartition).toHaveBeenCalledWith(partition);
    expect(steps).toEqual([
      `close ${JSON.stringify({ kind: 'agent', agentId: 'bare:gone' })}`,
      'unload extensions',
      'clearStorageData',
      'clearCache',
      'clearAuthCache',
      `rm ${folderOf(partition)}`,
      `forget ${partition}`,
    ]);
    expect(deleted).toHaveBeenCalledWith('bare:gone');
  });

  it("a deleted Agent's partition is no browser profile any more, and its session is forgotten", async () => {
    const partition = agentPartition('bare:gone-2');
    const { deps, session } = recordingDeps(folderOf(partition));
    rememberBrowserSession(partition, session as unknown as Electron.Session);

    await deleteAgentBrowserData('bare:gone-2', deps);

    expect(profileOfPartition(partition)).toBeNull();
    expect(partitionOfSession(session as unknown as Electron.Session)).toBeNull();
    // Recomputing the partition (a stale tab, an old chat) does not bring the profile back.
    expect(agentPartition('bare:gone-2')).toBe(partition);
    expect(profileOfPartition(partition)).toBeNull();
    expect(isDeletedAgentProfile('bare:gone-2')).toBe(true);
  });

  it('never removes a folder that is not exactly the partition folder under userData/Partitions', async () => {
    for (const storagePath of [null, USER_DATA, path.join(USER_DATA, 'Partitions'), path.join(USER_DATA, 'other')]) {
      const { deps } = recordingDeps(storagePath);

      await expect(deleteAgentBrowserData('bare:gone-3', deps)).rejects.toThrow();
      expect(deps.closeLiveContents).not.toHaveBeenCalled();
      expect(deps.removeDir).not.toHaveBeenCalled();
      expect(profileOfPartition(agentPartition('bare:gone-3'))).not.toBeNull();
    }
  });

  it('keeps the profile known when a step fails, so nothing claims it is gone', async () => {
    const partition = agentPartition('bare:busy');
    const { deps } = recordingDeps(folderOf(partition));
    deps.removeDir.mockRejectedValueOnce(new Error('EBUSY'));

    await expect(deleteAgentBrowserData('bare:busy', deps)).rejects.toThrow('EBUSY');
    expect(deps.forgetPartition).not.toHaveBeenCalled();
    expect(profileOfPartition(partition)).not.toBeNull();
  });

  it('rejects a bad Agent id before touching any session', async () => {
    const { deps } = recordingDeps(null);

    await expect(deleteAgentBrowserData('../../etc', deps)).rejects.toThrow();
    expect(deps.fromPartition).not.toHaveBeenCalled();
    expect(deps.removeDir).not.toHaveBeenCalled();
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

  /** A live page of `session` that goes away when closed, as Electron's does. */
  const livePage = (session: unknown, type = 'webview') =>
    Object.assign(new EventEmitter(), {
      session,
      getType: () => type,
      destroyed: false,
      isDestroyed(this: { destroyed: boolean }) {
        return this.destroyed;
      },
      close: vi.fn(function (this: EventEmitter & { destroyed: boolean }) {
        this.destroyed = true;
        this.emit('destroyed');
      }),
    });

  it("deleteProfileData drops the Agent's tabs, closes its live pages and extensions, then forgets the profile", async () => {
    const partition = agentPartition('bare:del');
    const { session } = fakeSession(path.join(USER_DATA_DIR, 'Partitions', partition.slice('persist:'.length)));
    const removeExtension = vi.fn();
    const agentSession = Object.assign(session, {
      extensions: { getAllExtensions: () => [{ id: 'ext-1' }], removeExtension },
    });
    ipc.fromPartition.mockReturnValue(agentSession);
    const page = livePage(agentSession);
    const other = livePage({});
    ipc.getAllWebContents.mockReturnValue([page, other]);

    expect(await call('deleteProfileData', { agentId: 'bare:del' })).toEqual({ success: true });

    expect(ipc.profileRemoved).toHaveBeenCalledWith({ agentId: 'bare:del' });
    expect(page.close).toHaveBeenCalled();
    expect(other.close).not.toHaveBeenCalled();
    expect(removeExtension).toHaveBeenCalledWith('ext-1');
    expect(session.clearStorageData).toHaveBeenCalled();
    expect(ipc.forgetBrowserSession).toHaveBeenCalledWith(partition);
    expect(ipc.forgetPermissions).toHaveBeenCalledWith(partition);
    expect(profileOfPartition(partition)).toBeNull();
  });

  it("clearProfileData also forgets the Agent's remembered site permissions", async () => {
    const partition = agentPartition('bare:clear');
    ipc.fromPartition.mockReturnValue(fakeSession(null).session);
    ipc.forgetPermissions.mockClear();

    expect(await call('clearProfileData', { agentId: 'bare:clear' })).toEqual({ success: true });
    expect(ipc.forgetPermissions).toHaveBeenCalledWith(partition);
  });

  it('refuses to clear or delete the shared default Agent profile', async () => {
    ipc.fromPartition.mockClear();
    ipc.profileRemoved.mockClear();

    expect((await call('deleteProfileData', { agentId: 'aion-default-agent' })).success).toBe(false);
    expect((await call('clearProfileData', { agentId: 'aion-default-agent' })).success).toBe(false);
    expect(ipc.fromPartition).not.toHaveBeenCalled();
    expect(ipc.profileRemoved).not.toHaveBeenCalled();
  });
});
