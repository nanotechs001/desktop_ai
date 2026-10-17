/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({ emit: vi.fn(), home: '' }));

vi.mock('@/common', () => ({ ipcBridge: { browser: { permissionRequested: { emit: mocks.emit } } } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = () => mocks.home;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

import {
  __resetPermissionsForTests,
  decidePermission,
  forgetPermissions,
  getPermissionRequests,
  installPermissions,
  loadPermissionStores,
  MAX_OPEN_PERMISSION_PROMPTS,
  PendingPermissions,
  rememberPermission,
  replyPermission,
  savePermissionStores,
  type PermissionStore,
} from '@process/services/browserSession/permissions';
import { agentPartition } from '@process/services/browserSession/profiles/browserProfiles';

const ORIGIN = 'https://a.test';
const PERSONAL = 'persist:aionui-browser';
const AGENT_PARTITION = agentPartition('bare:perm');
const PERSONAL_PROFILE = { kind: 'personal' } as const;

beforeEach(() => {
  mocks.home = mkdtempSync(path.join(tmpdir(), 'aionui-perm-'));
  mocks.emit.mockClear();
  __resetPermissionsForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('decidePermission', () => {
  it.each(['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'midiSysex'])(
    '%s asks when unknown',
    (permission) => {
      expect(decidePermission(permission, ORIGIN, {})).toBe('ask');
    }
  );

  it.each(['fullscreen', 'pointerLock', 'clipboard-sanitized-write'])('%s is always allowed', (permission) => {
    expect(decidePermission(permission, ORIGIN, {})).toBe('allow');
  });

  it.each(['openExternal', 'hid', 'serial', 'usb', 'idle-detection', 'unknown-perm'])('%s is denied', (permission) => {
    expect(decidePermission(permission, ORIGIN, {})).toBe('deny');
  });

  it('a remembered allow/deny for the origin wins over ask', () => {
    const store: PermissionStore = { [ORIGIN]: { media: 'allow', geolocation: 'deny' } };
    expect(decidePermission('media', ORIGIN, store)).toBe('allow');
    expect(decidePermission('geolocation', ORIGIN, store)).toBe('deny');
    expect(decidePermission('media', 'https://b.test', store)).toBe('ask');
  });

  it('never lets a stored value allow a permission outside the ask set', () => {
    expect(decidePermission('usb', ORIGIN, { [ORIGIN]: { usb: 'allow' } })).toBe('deny');
  });
});

describe('permission store', () => {
  it('rememberPermission returns a new store and leaves the input unchanged', () => {
    const before: PermissionStore = { [ORIGIN]: { media: 'allow' } };
    const after = rememberPermission(before, ORIGIN, 'geolocation', false);
    expect(after).toEqual({ [ORIGIN]: { media: 'allow', geolocation: 'deny' } });
    expect(before).toEqual({ [ORIGIN]: { media: 'allow' } });
    expect(after).not.toBe(before);
  });

  it('loadPermissionStores returns {} for a missing or corrupt file', () => {
    const file = path.join(mocks.home, 'store.json');
    expect(loadPermissionStores(file)).toEqual({});
    writeFileSync(file, '{not json');
    expect(loadPermissionStores(file)).toEqual({});
    writeFileSync(file, '[1,2]');
    expect(loadPermissionStores(file)).toEqual({});
  });

  it('loadPermissionStores drops entries that are not allow/deny', () => {
    const file = path.join(mocks.home, 'store.json');
    writeFileSync(
      file,
      JSON.stringify({ partitions: { [PERSONAL]: { [ORIGIN]: { media: 'allow', midi: 'maybe' }, bad: 'x' }, x: 5 } })
    );
    expect(loadPermissionStores(file)).toEqual({ [PERSONAL]: { [ORIGIN]: { media: 'allow' } } });
  });

  it("reads a flat (pre-profile) file as Personal's decisions", () => {
    const file = path.join(mocks.home, 'store.json');
    writeFileSync(file, JSON.stringify({ [ORIGIN]: { media: 'allow' } }));
    expect(loadPermissionStores(file)).toEqual({ [PERSONAL]: { [ORIGIN]: { media: 'allow' } } });
  });

  it('a flat (pre-profile) file survives a save: read as Personal, written partitioned, read back the same', () => {
    const file = path.join(mocks.home, 'store.json');
    writeFileSync(file, JSON.stringify({ [ORIGIN]: { media: 'allow', geolocation: 'deny' } }));
    const loaded = loadPermissionStores(file);
    const withAgent = { ...loaded, [AGENT_PARTITION]: { [ORIGIN]: { media: 'deny' as const } } };

    savePermissionStores(file, withAgent);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ partitions: withAgent });
    expect(loadPermissionStores(file)).toEqual({
      [PERSONAL]: { [ORIGIN]: { media: 'allow', geolocation: 'deny' } },
      [AGENT_PARTITION]: { [ORIGIN]: { media: 'deny' } },
    });
  });

  it('savePermissionStores removes its temp file and rethrows when the rename fails', () => {
    const file = path.join(mocks.home, 'blocked');
    mkdirSync(file); // renaming a file over a directory fails
    expect(() => savePermissionStores(file, {})).toThrow();
    expect(readdirSync(mocks.home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('savePermissionStores round-trips per partition and creates the parent directory', () => {
    const file = path.join(mocks.home, 'nested', 'store.json');
    const stores = { [PERSONAL]: { [ORIGIN]: { media: 'deny' as const } }, [AGENT_PARTITION]: {} };
    savePermissionStores(file, stores);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ partitions: stores });
    expect(loadPermissionStores(file)).toEqual(stores);
  });
});

describe('PendingPermissions', () => {
  const req: Omit<PermissionRequest, 'id'> = {
    origin: ORIGIN,
    permission: 'media',
    mediaTypes: ['video'],
    partition: PERSONAL,
    profile: PERSONAL_PROFILE,
  };

  it('resolves the promise with the reply and removes the request', async () => {
    const pending = new PendingPermissions();
    const onChange = vi.fn();
    pending.onChange(onChange);
    const result = pending.request(req, 60_000);
    const [open] = onChange.mock.calls[0];
    expect(open).toEqual([{ ...req, id: expect.any(String) }]);

    expect(pending.reply(open[0].id, true)).toBe(true);
    await expect(result).resolves.toBe(true);
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(pending.reply(open[0].id, true)).toBe(false);
  });

  it('denies and removes a request after the timeout (60 000 ms)', async () => {
    const pending = new PendingPermissions();
    const onChange = vi.fn();
    pending.onChange(onChange);
    const result = pending.request(req, 60_000);
    const id = onChange.mock.calls[0][0][0].id;

    vi.advanceTimersByTime(59_999);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await expect(result).resolves.toBe(false);
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(pending.reply(id, true)).toBe(false);
  });

  it('clears the timer when answered', async () => {
    const pending = new PendingPermissions();
    const result = pending.request(req, 60_000);
    const id = pending.list()[0].id;
    pending.reply(id, true);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one open request between callers with the same origin and permission', async () => {
    const pending = new PendingPermissions();
    const first = pending.request(req, 60_000);
    const second = pending.request(req, 60_000);
    const other = pending.request({ ...req, permission: 'geolocation' }, 60_000);
    expect(pending.list()).toHaveLength(2);

    pending.reply(pending.list()[0].id, false);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(pending.list()).toHaveLength(1);
    pending.reply(pending.list()[0].id, true);
    await expect(other).resolves.toBe(true);
  });

  it('keeps one prompt per profile: the same site asking in two profiles at once gets two prompts', () => {
    const pending = new PendingPermissions();
    void pending.request(req, 60_000);
    void pending.request(
      { ...req, partition: AGENT_PARTITION, profile: { kind: 'agent', agentId: 'bare:perm' } },
      60_000
    );

    expect(pending.list().map((r) => r.partition)).toEqual([PERSONAL, AGENT_PARTITION]);
  });

  it('auto-denies a request beyond the open-prompt cap without listing it', async () => {
    const pending = new PendingPermissions();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < MAX_OPEN_PERMISSION_PROMPTS; i++) {
      void pending.request({ ...req, origin: `https://o${i}.test` }, 60_000);
    }
    const onChange = vi.fn();
    pending.onChange(onChange);

    await expect(pending.request({ ...req, origin: 'https://extra.test' }, 60_000)).resolves.toBe(false);
    expect(pending.list()).toHaveLength(MAX_OPEN_PERMISSION_PROMPTS);
    expect(onChange).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('https://extra.test');
    expect(warn.mock.calls[0][0]).toContain('media');
    warn.mockRestore();
  });

  it('still shares an already-open request when the cap is reached', async () => {
    const pending = new PendingPermissions();
    for (let i = 0; i < MAX_OPEN_PERMISSION_PROMPTS; i++) {
      void pending.request({ ...req, origin: `https://o${i}.test` }, 60_000);
    }
    const shared = pending.request({ ...req, origin: 'https://o0.test' }, 60_000);
    expect(pending.list()).toHaveLength(MAX_OPEN_PERMISSION_PROMPTS);

    pending.reply(pending.list()[0].id, true);
    await expect(shared).resolves.toBe(true);
  });

  it('unions mediaTypes into the open request and re-emits the list', () => {
    const pending = new PendingPermissions();
    const onChange = vi.fn();
    void pending.request({ ...req, mediaTypes: ['video'] }, 60_000);
    pending.onChange(onChange);
    void pending.request({ ...req, mediaTypes: ['audio'] }, 60_000);
    void pending.request({ ...req, mediaTypes: ['audio'] }, 60_000);

    expect(pending.list()).toHaveLength(1);
    expect(pending.list()[0].mediaTypes).toEqual(['video', 'audio']);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(pending.list());
  });

  it('onChange returns an unsubscribe function', () => {
    const pending = new PendingPermissions();
    const onChange = vi.fn();
    pending.onChange(onChange)();
    void pending.request(req, 60_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('installPermissions', () => {
  type RequestHandler = (
    contents: { getURL: () => string },
    permission: string,
    callback: (granted: boolean) => void,
    details: { requestingUrl?: string; mediaTypes?: string[] }
  ) => void;
  type CheckHandler = (
    contents: unknown,
    permission: string,
    requestingOrigin: string,
    details: { requestingUrl?: string }
  ) => boolean;

  const setup = (partition = PERSONAL) => {
    let request!: RequestHandler;
    let check!: CheckHandler;
    installPermissions(
      {
        setPermissionRequestHandler: (handler: RequestHandler) => {
          request = handler;
        },
        setPermissionCheckHandler: (handler: CheckHandler) => {
          check = handler;
        },
      } as unknown as Electron.Session,
      partition
    );
    return { request, check };
  };
  const contents = { getURL: () => `${ORIGIN}/page` };

  it('auto-allows, denies and asks according to the policy', async () => {
    const { request } = setup();
    const callback = vi.fn();
    request(contents, 'fullscreen', callback, { requestingUrl: `${ORIGIN}/x` });
    request(contents, 'usb', callback, { requestingUrl: `${ORIGIN}/x` });
    expect(callback.mock.calls).toEqual([[true], [false]]);
    expect(getPermissionRequests()).toEqual([]);

    request(contents, 'media', callback, { requestingUrl: `${ORIGIN}/x`, mediaTypes: ['audio', 'video'] });
    expect(getPermissionRequests()).toEqual([
      {
        id: expect.any(String),
        origin: ORIGIN,
        permission: 'media',
        mediaTypes: ['audio', 'video'],
        partition: PERSONAL,
        profile: PERSONAL_PROFILE,
      },
    ]);
    expect(mocks.emit).toHaveBeenLastCalledWith(getPermissionRequests());
    expect(callback).toHaveBeenCalledTimes(2);

    expect(replyPermission(getPermissionRequests()[0].id, true, false)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenLastCalledWith(true);
  });

  it('publishes each prompt change once, however many browser profiles installed the policy', () => {
    setup();
    const { request } = setup();
    mocks.emit.mockClear();

    request(contents, 'geolocation', vi.fn(), { requestingUrl: `${ORIGIN}/x` });

    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });

  it('attributes the prompt to the requesting frame, not the top-level page', () => {
    const { request } = setup();
    request({ getURL: () => 'https://top.test/page' }, 'geolocation', vi.fn(), {
      requestingUrl: 'https://frame.test/x',
    });
    expect(getPermissionRequests()[0].origin).toBe('https://frame.test');
  });

  it('falls back to the webContents URL when details has no requestingUrl', () => {
    const { request } = setup();
    request(contents, 'geolocation', vi.fn(), {});
    expect(getPermissionRequests()[0].origin).toBe(ORIGIN);
  });

  it.each(['about:blank', 'not a url', ''])('denies without prompting for the unusable url %j', (url) => {
    const { request } = setup();
    const callback = vi.fn();
    request({ getURL: () => url }, 'media', callback, {});
    expect(callback).toHaveBeenCalledWith(false);
    expect(getPermissionRequests()).toEqual([]);
  });

  it('remembers the answer and applies it to later requests without prompting', async () => {
    const { request } = setup();
    request(contents, 'geolocation', vi.fn(), {});
    replyPermission(getPermissionRequests()[0].id, true, true);

    const callback = vi.fn();
    request(contents, 'geolocation', callback, {});
    expect(callback).toHaveBeenCalledWith(true);
    expect(getPermissionRequests()).toEqual([]);
    const saved = JSON.parse(readFileSync(path.join(mocks.home, '.aionui', 'browser-permissions.json'), 'utf8'));
    expect(saved).toEqual({ partitions: { [PERSONAL]: { [ORIGIN]: { geolocation: 'allow' } } } });
  });

  it('Always allow in Personal does not apply in an Agent partition, and vice versa', async () => {
    const personal = setup();
    const agent = setup(AGENT_PARTITION);
    const details = { requestingUrl: `${ORIGIN}/x` };
    personal.request(contents, 'geolocation', vi.fn(), {});
    expect(getPermissionRequests()[0]).toMatchObject({ partition: PERSONAL, profile: PERSONAL_PROFILE });
    replyPermission(getPermissionRequests()[0].id, true, true);

    expect(personal.check(null, 'geolocation', ORIGIN, details)).toBe(true);
    expect(agent.check(null, 'geolocation', ORIGIN, details)).toBe(false);
    const callback = vi.fn();
    agent.request(contents, 'geolocation', callback, {});
    expect(callback).not.toHaveBeenCalled();
    expect(getPermissionRequests()).toEqual([
      expect.objectContaining({ partition: AGENT_PARTITION, profile: { kind: 'agent', agentId: 'bare:perm' } }),
    ]);
    replyPermission(getPermissionRequests()[0].id, false, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledWith(false);
    expect(personal.check(null, 'geolocation', ORIGIN, details)).toBe(true);
  });

  it("forgetPermissions drops a deleted Agent's decisions and keeps the other profiles'", () => {
    const personal = setup();
    const agent = setup(AGENT_PARTITION);
    const details = { requestingUrl: `${ORIGIN}/x` };
    personal.request(contents, 'media', vi.fn(), {});
    replyPermission(getPermissionRequests()[0].id, true, true);
    agent.request(contents, 'media', vi.fn(), {});
    replyPermission(getPermissionRequests()[0].id, true, true);

    forgetPermissions(AGENT_PARTITION);

    expect(agent.check(null, 'media', ORIGIN, details)).toBe(false);
    expect(personal.check(null, 'media', ORIGIN, details)).toBe(true);
    const saved = JSON.parse(readFileSync(path.join(mocks.home, '.aionui', 'browser-permissions.json'), 'utf8'));
    expect(Object.keys(saved.partitions)).toEqual([PERSONAL]);
  });

  it('does not remember when remember is false, and a late reply returns false', () => {
    const { request } = setup();
    request(contents, 'notifications', vi.fn(), {});
    const id = getPermissionRequests()[0].id;
    expect(replyPermission(id, true, false)).toBe(true);
    expect(replyPermission(id, true, true)).toBe(false);
    const callback = vi.fn();
    request(contents, 'notifications', callback, {});
    expect(getPermissionRequests()).toHaveLength(1);
  });

  it('the permission check handler returns true only for remembered allows and always-allow permissions', () => {
    const { request, check } = setup();
    const details = { requestingUrl: `${ORIGIN}/x` };
    expect(check(null, 'fullscreen', ORIGIN, details)).toBe(true);
    expect(check(null, 'media', ORIGIN, details)).toBe(false);
    expect(check(null, 'usb', ORIGIN, details)).toBe(false);

    request(contents, 'media', vi.fn(), {});
    replyPermission(getPermissionRequests()[0].id, true, true);
    expect(check(null, 'media', ORIGIN, details)).toBe(true);
    expect(check(null, 'media', 'https://b.test', { requestingUrl: 'https://b.test/' })).toBe(false);
    expect(getPermissionRequests()).toEqual([]);
  });

  it('uses chrome-extension://<id> as the origin of extension pages, so they can prompt and be allowed', () => {
    const { request, check } = setup();
    const extensionUrl = 'chrome-extension://abcdefghijklmnop/popup.html';

    request({ getURL: () => extensionUrl }, 'notifications', vi.fn(), {});

    expect(getPermissionRequests()[0].origin).toBe('chrome-extension://abcdefghijklmnop');
    expect(check(null, 'fullscreen', 'chrome-extension://abcdefghijklmnop', { requestingUrl: extensionUrl })).toBe(
      true
    );
  });

  it('after 3 dismissals for an origin+permission, denies without prompting until restart', () => {
    const { request } = setup();
    for (let i = 0; i < 3; i += 1) {
      request(contents, 'geolocation', vi.fn(), {});
      replyPermission(getPermissionRequests()[0].id, false, false);
    }

    const callback = vi.fn();
    request(contents, 'geolocation', callback, {});

    expect(callback).toHaveBeenCalledWith(false);
    expect(getPermissionRequests()).toEqual([]);
    // Other permissions, other sites and other profiles still prompt.
    setup(AGENT_PARTITION).request(contents, 'geolocation', vi.fn(), {});
    expect(getPermissionRequests().map((r) => r.partition)).toEqual([AGENT_PARTITION]);
    replyPermission(getPermissionRequests()[0].id, true, false);
    request(contents, 'notifications', vi.fn(), {});
    request({ getURL: () => 'https://b.test/' }, 'geolocation', vi.fn(), {});
    expect(getPermissionRequests().map((r) => `${r.origin} ${r.permission}`)).toEqual([
      `${ORIGIN} notifications`,
      'https://b.test geolocation',
    ]);
  });

  it('two dismissals still prompt', () => {
    const { request } = setup();
    for (let i = 0; i < 2; i += 1) {
      request(contents, 'media', vi.fn(), {});
      replyPermission(getPermissionRequests()[0].id, false, false);
    }
    request(contents, 'media', vi.fn(), {});

    expect(getPermissionRequests()).toHaveLength(1);
  });

  it('the check handler falls back to requestingOrigin and denies an opaque origin', () => {
    const { check } = setup();
    expect(check(null, 'fullscreen', ORIGIN, {})).toBe(true);
    expect(check(null, 'fullscreen', 'null', {})).toBe(false);
  });
});
