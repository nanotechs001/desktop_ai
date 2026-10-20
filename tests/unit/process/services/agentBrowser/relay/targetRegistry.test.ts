import { describe, expect, it, vi } from 'vitest';
import {
  createTargetRegistry,
  targetIdFor,
  webContentsIdFromTargetId,
} from '@process/services/agentBrowser/relay/targetRegistry';
import { FakeContents } from './fakes';

const agent = { clientId: 'c1', label: 'claude' };

describe('targetRegistry', () => {
  it('maps webContents ids to target ids and back', () => {
    expect(targetIdFor(12)).toBe('wc-12');
    expect(webContentsIdFromTargetId('wc-12')).toBe(12);
    expect(webContentsIdFromTargetId('wc-x')).toBeNull();
    expect(webContentsIdFromTargetId('12')).toBeNull();
  });

  it('tracks tabs as user-owned and claim() hands one to a client', () => {
    const registry = createTargetRegistry();
    const onChange = vi.fn();
    registry.onChange(onChange);
    registry.track(new FakeContents(5));
    const personal = { kind: 'personal' };
    expect(registry.ownership(5)).toEqual({
      webContentsId: 5,
      owner: 'user',
      sharedWith: null,
      profile: personal,
    });
    registry.claim(5, agent);
    expect(registry.ownership(5)?.owner).toEqual(agent);
    expect(onChange).toHaveBeenLastCalledWith([
      { webContentsId: 5, owner: agent, sharedWith: null, profile: personal },
    ]);
  });

  it('stores the claiming conversation on the owner, and keeps it after the client disconnects', () => {
    const registry = createTargetRegistry();
    registry.track(new FakeContents(8));
    registry.claim(8, { ...agent, conversationId: 'conv-1' });
    expect(registry.ownership(8)?.owner).toEqual({ ...agent, conversationId: 'conv-1' });
    registry.releaseClient('c1');
    expect(registry.ownership(8)?.owner).toEqual({
      clientId: 'disconnected:c1',
      label: 'agent (disconnected)',
      conversationId: 'conv-1',
    });
  });

  it("inherit() gives a tab its agent opener's owner and chat; a user opener's child stays the user's", () => {
    const registry = createTargetRegistry();
    for (const id of [1, 2, 3, 4]) registry.track(new FakeContents(id));
    registry.claim(1, { ...agent, conversationId: 'conv-1' });
    registry.share(3, true);

    registry.inherit(1, 2);
    registry.inherit(1, 2);
    registry.inherit(3, 4);
    registry.inherit(99, 4);

    expect(registry.ownership(2)?.owner).toEqual({ ...agent, conversationId: 'conv-1' });
    expect(registry.ownership(4)?.owner).toBe('user');
  });

  it("records each tab's browser profile, and an owner is only the client's id and label", () => {
    const registry = createTargetRegistry();
    const profile = { kind: 'agent', agentId: 'bare:x' } as const;
    registry.track(new FakeContents(6), profile);
    registry.claim(6, { ...agent, profile });

    expect(registry.ownership(6)?.profile).toEqual(profile);
    expect(registry.ownership(6)?.owner).toEqual(agent);
  });

  it('keeps notifying other listeners when one throws', () => {
    const registry = createTargetRegistry();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = vi.fn();
    registry.onChange(() => {
      throw new Error('boom');
    });
    registry.onChange(second);
    registry.track(new FakeContents(9));
    expect(second).toHaveBeenCalled();
  });

  it('keeps a disconnected client tabs open but no longer reclaimable', () => {
    const registry = createTargetRegistry();
    registry.track(new FakeContents(3));
    registry.claim(3, agent);
    registry.releaseClient('c1');
    expect(registry.ownership(3)?.owner).toEqual({ clientId: 'disconnected:c1', label: 'agent (disconnected)' });
  });

  it('forgets destroyed contents and reports their last ownership', () => {
    const registry = createTargetRegistry();
    const onDestroyed = vi.fn();
    registry.onDestroyed(onDestroyed);
    const contents = new FakeContents(4);
    registry.track(contents);
    registry.claim(4, agent);
    contents.destroy();
    expect(onDestroyed).toHaveBeenCalledWith({
      webContentsId: 4,
      owner: agent,
      sharedWith: null,
      profile: { kind: 'personal' },
    });
    expect(registry.ownership(4)).toBeNull();
    expect(registry.listTargets()).toEqual([]);
  });

  it('lists tracked targets as CDP page targets', () => {
    const registry = createTargetRegistry();
    registry.track(new FakeContents(6, 'https://example.com/', 'Example'));
    expect(registry.listTargets()).toEqual([
      {
        targetId: 'wc-6',
        type: 'page',
        title: 'Example',
        url: 'https://example.com/',
        attached: false,
        canAccessOpener: false,
      },
    ]);
  });
});

describe('targetRegistry: typed since load', () => {
  const A = { key: 'a', code: 'KeyA' };

  it('marks a user key, not an in-flight agent key; forgets on a new page and when the tab goes', () => {
    const registry = createTargetRegistry();
    const tab = new FakeContents(4);
    registry.track(tab);

    const end = registry.beginAgentKey(4, A);
    expect(registry.isAgentKey(4, A)).toBe(true);
    registry.noteUserKey(4, A);
    expect(registry.typedSinceLoad(4)).toBe(false);
    registry.noteUserKey(4, { key: 'b', code: 'KeyB' });
    expect(registry.typedSinceLoad(4)).toBe(true);

    registry.clearTyped(4);
    end();
    registry.noteUserKey(4, A);
    expect(registry.typedSinceLoad(4)).toBe(true);

    tab.destroy();
    expect(registry.typedSinceLoad(4)).toBe(false);
  });

  it('counts a key with no report to match (the phone) as the user, and forgets an unsettled agent key', () => {
    vi.useFakeTimers();
    try {
      const registry = createTargetRegistry();
      registry.track(new FakeContents(5));
      registry.beginAgentKey(5, A);
      vi.advanceTimersByTime(5001);
      expect(registry.isAgentKey(5, A)).toBe(false);

      registry.noteUserKey(5);
      expect(registry.typedSinceLoad(5)).toBe(true);
      registry.noteUserKey(99);
      expect(registry.typedSinceLoad(99)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
