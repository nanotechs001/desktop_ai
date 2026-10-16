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

  it('pauses an agent or shared tab on user input, but not a private user tab or during agent input', () => {
    const registry = createTargetRegistry();
    registry.track(new FakeContents(1));
    registry.track(new FakeContents(2));
    registry.claim(2, agent);

    registry.noteUserInput(1);
    expect(registry.ownership(1)?.paused).toBe(false);

    const endAgentInput = registry.beginAgentInput(2);
    registry.noteUserInput(2); // the agent's own CDP mouse event fires before-mouse-event too
    expect(registry.ownership(2)?.paused).toBe(false);
    endAgentInput();

    registry.noteUserInput(2);
    expect(registry.ownership(2)?.paused).toBe(true);

    registry.share(1, true);
    registry.noteUserInput(1);
    expect(registry.ownership(1)?.paused).toBe(true);

    registry.setPaused(2, false);
    expect(registry.ownership(2)?.paused).toBe(false);
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
