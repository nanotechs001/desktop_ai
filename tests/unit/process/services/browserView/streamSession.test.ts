import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserViewService, type StreamPeer } from '@process/services/agentBrowser/relay/browserView';
import { ALLOWED_VIEWER_METHODS, decodeFrame } from '@process/services/agentBrowser/relay/browserView/protocol';
import { createDebuggerSessions, type DebuggerSessions } from '@process/services/agentBrowser/relay/debuggerSessions';
import { createTargetRegistry, type TargetRegistry } from '@process/services/agentBrowser/relay/targetRegistry';
import { FakeContents } from '../agentBrowser/relay/fakes';

type Handle = { onMessage(raw: string): void; close(): void };

const META = {
  offsetTop: 0,
  pageScaleFactor: 2,
  deviceWidth: 400,
  deviceHeight: 800,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
  timestamp: 1,
};

class FakePeer implements StreamPeer {
  readonly frames: Buffer[] = [];
  readonly texts: Array<Record<string, unknown>> = [];
  readonly closes: Array<[number, string]> = [];
  sendBinary(b: Buffer): void {
    this.frames.push(b);
  }
  sendText(s: string): void {
    this.texts.push(JSON.parse(s) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    this.closes.push([code, reason]);
  }
}

let registry: TargetRegistry;
let sessions: DebuggerSessions;
let service: ReturnType<typeof createBrowserViewService>;
let tab: FakeContents;
const open: Handle[] = [];

const send = (handle: Handle, message: Record<string, unknown>): void => handle.onMessage(JSON.stringify(message));

/** CDP methods sent on the tab's debugger. */
const commands = (): Array<{ method: string; params: Record<string, unknown> }> =>
  tab.debugger.sendCommand.mock.calls.map(([method, params]) => ({
    method,
    params: (params ?? {}) as Record<string, unknown>,
  }));
const sent = (method: string) => commands().filter((c) => c.method === method);

const frame = (contents: FakeContents, meta: Record<string, unknown> = META, sessionId = 1): void =>
  contents.debugger.message('Page.screencastFrame', {
    data: Buffer.from('jpeg').toString('base64'),
    metadata: meta,
    sessionId,
  });

/** The agent's own relay session on the tab, as `relayServer` opens it. */
const agentSession = async (contents: FakeContents): Promise<string> => {
  const id = await sessions.attach(contents, { id: 'agent-client', emit: vi.fn() });
  sessions.ready(id);
  return id;
};

const stream = async (tabId: string, peer = new FakePeer()): Promise<{ handle: Handle; peer: FakePeer }> => {
  const result = await service.openStream(tabId, peer);
  if ('error' in result) throw new Error(result.error);
  open.push(result);
  return { handle: result, peer };
};

beforeEach(() => {
  vi.useFakeTimers();
  registry = createTargetRegistry();
  sessions = createDebuggerSessions();
  service = createBrowserViewService({ registry, sessions });
  tab = new FakeContents(7);
  registry.track(tab);
  registry.claim(7, { clientId: 'agent-client', label: 'claude', conversationId: 'conv-1' });
});

afterEach(() => {
  open.splice(0).forEach((h) => h.close());
  vi.useRealTimers();
});

describe('browser view: listing and opening', () => {
  it('lists the viewable tabs of a conversation', () => {
    expect(service.listTabs('conv-1')).toEqual([
      { id: 'wc-7', title: 'Example', url: 'https://example.com/', paused: false },
    ]);
    expect(service.listTabs('other')).toEqual([]);
  });

  it('refuses a user tab and an unknown tab', async () => {
    registry.track(new FakeContents(8));
    expect(await service.openStream('wc-8', new FakePeer())).toEqual({ error: 'not-allowed' });
    expect(await service.openStream('wc-999', new FakePeer())).toEqual({ error: 'tab-closed' });
    expect(await service.openStream('nonsense', new FakePeer())).toEqual({ error: 'tab-closed' });
  });

  it('sends the tab on open', async () => {
    const { peer } = await stream('wc-7');
    expect(peer.texts[0]).toEqual({ type: 'tab', title: 'Example', url: 'https://example.com/', paused: false });
  });
});

describe('browser view: frames', () => {
  it('hello starts a jpeg screencast no wider than 1280 device px', async () => {
    const { handle } = await stream('wc-7');
    send(handle, { type: 'hello', width: 390, dpr: 3 });
    send(handle, { type: 'hello', width: 800, dpr: 2 });
    expect(sent('Page.startScreencast').map((c) => c.params)).toEqual([
      { format: 'jpeg', quality: 55, maxWidth: 1170 },
      { format: 'jpeg', quality: 55, maxWidth: 1280 },
    ]);
  });

  it('keeps one frame in flight and acks CDP only after the phone acks', async () => {
    const { handle, peer } = await stream('wc-7');
    send(handle, { type: 'hello', width: 390, dpr: 3 });

    frame(tab);
    frame(tab, { ...META, scrollOffsetY: 50 });
    expect(peer.frames).toHaveLength(1);
    expect(decodeFrame(new Uint8Array(peer.frames[0]).buffer).meta).toEqual({
      offsetTop: 0,
      pageScaleFactor: 2,
      deviceWidth: 400,
      deviceHeight: 800,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    });
    expect(sent('Page.screencastFrameAck')).toHaveLength(0);

    send(handle, { type: 'ack' });
    expect(sent('Page.screencastFrameAck').map((c) => c.params)).toEqual([{ sessionId: 1 }]);
    expect(peer.frames).toHaveLength(2);
    expect(decodeFrame(new Uint8Array(peer.frames[1]).buffer).meta.scrollOffsetY).toBe(50);
  });

  it('a new stream on the same tab starts unpaced', async () => {
    const first = await stream('wc-7');
    send(first.handle, { type: 'hello', width: 390, dpr: 3 });
    frame(tab);
    const second = await stream('wc-7');
    send(second.handle, { type: 'hello', width: 390, dpr: 3 });

    frame(tab);

    expect(first.peer.frames).toHaveLength(1);
    expect(second.peer.frames).toHaveLength(1);
  });

  it('closing one of two streams leaves the screencast running for the other', async () => {
    const first = await stream('wc-7');
    const second = await stream('wc-7');
    send(first.handle, { type: 'hello', width: 390, dpr: 3 });
    send(second.handle, { type: 'hello', width: 390, dpr: 3 });

    first.handle.close();
    expect(sent('Page.stopScreencast')).toHaveLength(0);
    frame(tab);
    expect(second.peer.frames).toHaveLength(1);

    second.handle.close();
    expect(sent('Page.stopScreencast')).toHaveLength(1);
  });

  it('sends no-frames 5 s after hello when no frame came', async () => {
    const { handle, peer } = await stream('wc-7');
    send(handle, { type: 'hello', width: 390, dpr: 3 });
    vi.advanceTimersByTime(4999);
    expect(peer.texts).not.toContainEqual({ type: 'no-frames' });
    vi.advanceTimersByTime(1);
    expect(peer.texts).toContainEqual({ type: 'no-frames' });
  });

  it('sends no no-frames once a frame came', async () => {
    const { handle, peer } = await stream('wc-7');
    send(handle, { type: 'hello', width: 390, dpr: 3 });
    frame(tab);
    vi.advanceTimersByTime(10_000);
    expect(peer.texts).not.toContainEqual({ type: 'no-frames' });
  });
});

describe('browser view: sharing the tab debugger', () => {
  it('the viewer survives the agent detaching, and closing it leaves the agent attached', async () => {
    const agent = await agentSession(tab);
    const { handle, peer } = await stream('wc-7');
    send(handle, { type: 'hello', width: 390, dpr: 3 });

    sessions.detachSession(agent);
    frame(tab);
    expect(peer.frames).toHaveLength(1);
    expect(tab.debugger.isAttached()).toBe(true);

    const agentAgain = await agentSession(tab);
    handle.close();
    expect(sent('Page.stopScreencast')).toHaveLength(1);
    expect(sessions.session(agentAgain)).not.toBeNull();
    expect(tab.debugger.isAttached()).toBe(true);
  });

  it('the last viewer closing releases the debugger', async () => {
    const { handle } = await stream('wc-7');
    expect(tab.debugger.isAttached()).toBe(true);
    handle.close();
    expect(tab.debugger.isAttached()).toBe(false);
  });

  it('a debugger that detaches under the viewer closes it as tab-closed', async () => {
    const { peer } = await stream('wc-7');
    tab.debugger.emit('detach', {}, 'target closed');
    expect(peer.texts).toContainEqual({ type: 'closed', reason: 'tab-closed' });
    expect(peer.closes).toHaveLength(1);
  });
});

describe('browser view: phone input', () => {
  const streaming = async () => {
    await agentSession(tab);
    tab.debugger.sendCommand.mockClear();
    const s = await stream('wc-7');
    send(s.handle, { type: 'hello', width: 390, dpr: 3 });
    frame(tab);
    return s;
  };

  it('tap moves, presses and releases at the mapped point and pauses the agent', async () => {
    const { handle } = await streaming();
    send(handle, { type: 'tap', nx: 0.5, ny: 0.25 });
    expect(sent('Input.dispatchMouseEvent').map((c) => c.params)).toEqual([
      { type: 'mouseMoved', x: 100, y: 100 },
      { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 100, y: 100, button: 'left', clickCount: 1 },
    ]);
    expect(registry.ownership(7)?.paused).toBe(true);
  });

  it('scroll, text and key send their commands', async () => {
    const { handle } = await streaming();
    send(handle, { type: 'scroll', nx: 0.5, ny: 0.5, dy: 120 });
    send(handle, { type: 'text', value: 'hi' });
    send(handle, { type: 'key', key: 'Enter' });
    expect(sent('Input.dispatchMouseEvent').map((c) => c.params)).toEqual([
      { type: 'mouseWheel', x: 100, y: 200, deltaX: 0, deltaY: 120 },
    ]);
    expect(sent('Input.insertText').map((c) => c.params)).toEqual([{ text: 'hi' }]);
    expect(sent('Input.dispatchKeyEvent').map((c) => c.params)).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    ]);
  });

  it('never sends a method outside the viewer allowlist', async () => {
    const { handle } = await streaming();
    for (const raw of [
      '{"type":"tap","nx":0.1,"ny":0.1}',
      '{"type":"scroll","nx":0.1,"ny":0.1,"dy":-5}',
      '{"type":"text","value":"x"}',
      '{"type":"key","key":"Tab"}',
      '{"type":"ack"}',
      '{"type":"resume"}',
      '{"type":"eval","expression":"1"}',
      '{"method":"Runtime.evaluate"}',
      'not json',
    ]) {
      handle.onMessage(raw);
    }
    handle.close();
    for (const { method } of commands()) expect(ALLOWED_VIEWER_METHODS.has(method)).toBe(true);
  });

  it('resume unpauses the agent', async () => {
    const { handle } = await streaming();
    registry.setPaused(7, true);
    send(handle, { type: 'resume' });
    expect(registry.ownership(7)?.paused).toBe(false);
  });
});

describe('browser view: registry changes', () => {
  it('a paused change sends the tab again', async () => {
    const { peer } = await stream('wc-7');
    registry.setPaused(7, true);
    expect(peer.texts.at(-1)).toEqual({ type: 'tab', title: 'Example', url: 'https://example.com/', paused: true });
  });

  it('unsharing closes the stream as not-allowed and stops input', async () => {
    const shared = new FakeContents(9);
    registry.track(shared);
    registry.share(9, true);
    const { handle, peer } = await stream('wc-9');
    send(handle, { type: 'hello', width: 390, dpr: 3 });
    frame(shared);

    registry.share(9, false);

    expect(peer.texts.at(-1)).toEqual({ type: 'closed', reason: 'not-allowed' });
    expect(peer.closes).toHaveLength(1);
    shared.debugger.sendCommand.mockClear();
    send(handle, { type: 'tap', nx: 0.5, ny: 0.5 });
    expect(shared.debugger.sendCommand).not.toHaveBeenCalled();
  });

  it('destroying the tab closes the stream as tab-closed', async () => {
    const { peer } = await stream('wc-7');
    tab.destroy();
    expect(peer.texts).toContainEqual({ type: 'closed', reason: 'tab-closed' });
    expect(peer.closes).toHaveLength(1);
  });

  it('a navigation or title change sends the tab again', async () => {
    const { peer } = await stream('wc-7');
    tab.pendingUrl = 'https://example.com/next';
    vi.spyOn(tab, 'getTitle').mockReturnValue('Next');
    vi.advanceTimersByTime(1000);
    expect(peer.texts.at(-1)).toEqual({ type: 'tab', title: 'Next', url: 'https://example.com/next', paused: false });
    const count = peer.texts.length;
    vi.advanceTimersByTime(3000);
    expect(peer.texts).toHaveLength(count);
  });
});
