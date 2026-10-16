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
    expect(registry.ownership(5)).toEqual({ webContentsId: 5, owner: 'user', sharedWith: null, paused: false });
    registry.claim(5, agent);
    expect(registry.ownership(5)?.owner).toEqual(agent);
    expect(onChange).toHaveBeenLastCalledWith([{ webContentsId: 5, owner: agent, sharedWith: null, paused: false }]);
  });

  it('pauses an agent or shared tab on user input, but not a private user tab', () => {
    const registry = createTargetRegistry();
    registry.track(new FakeContents(1));
    registry.track(new FakeContents(2));
    registry.claim(2, agent);

    registry.noteUserInput(1, { kind: 'key' });
    registry.noteUserInput(1, { kind: 'mouse', x: 1, y: 1 });
    expect(registry.ownership(1)?.paused).toBe(false);

    registry.noteUserInput(2, { kind: 'key' });
    expect(registry.ownership(2)?.paused).toBe(true);

    registry.share(1, true);
    registry.noteUserInput(1, { kind: 'mouse', x: 1, y: 1 });
    expect(registry.ownership(1)?.paused).toBe(true);

    registry.setPaused(2, false);
    expect(registry.ownership(2)?.paused).toBe(false);
  });

  it('suppresses only the mouseDown Electron reports for an in-flight agent click (±2 px), once', () => {
    const registry = createTargetRegistry();
    registry.track(new FakeContents(2));
    registry.claim(2, agent);
    const end = registry.beginAgentInput(2, { x: 100, y: 50 });

    registry.noteUserInput(2, { kind: 'mouse', x: 101.5, y: 48 });
    expect(registry.ownership(2)?.paused).toBe(false);
    // The same coordinates again are the user, not the agent: one report per agent click.
    registry.noteUserInput(2, { kind: 'mouse', x: 100, y: 50 });
    expect(registry.ownership(2)?.paused).toBe(true);
    end();
  });

  it('never suppresses a user keyDown or a click elsewhere during an agent click', () => {
    const registry = createTargetRegistry();
    registry.track(new FakeContents(2));
    registry.track(new FakeContents(3));
    registry.claim(2, agent);
    registry.claim(3, agent);
    registry.beginAgentInput(2, { x: 100, y: 50 });
    registry.beginAgentInput(3, { x: 100, y: 50 });

    registry.noteUserInput(2, { kind: 'key' });
    registry.noteUserInput(3, { kind: 'mouse', x: 103, y: 50 });

    expect(registry.ownership(2)?.paused).toBe(true);
    expect(registry.ownership(3)?.paused).toBe(true);
  });

  it('forgets an in-flight agent click after 5 s even if its command never settles', () => {
    vi.useFakeTimers();
    try {
      const registry = createTargetRegistry();
      registry.track(new FakeContents(2));
      registry.claim(2, agent);
      registry.beginAgentInput(2, { x: 10, y: 10 });
      vi.advanceTimersByTime(5000);
      registry.noteUserInput(2, { kind: 'mouse', x: 10, y: 10 });
      expect(registry.ownership(2)?.paused).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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
    expect(onDestroyed).toHaveBeenCalledWith({ webContentsId: 4, owner: agent, sharedWith: null, paused: false });
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
