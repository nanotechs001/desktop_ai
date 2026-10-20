import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserViewService, type StreamPeer } from '@process/services/agentBrowser/relay/browserView';
import { ALLOWED_VIEWER_METHODS } from '@process/services/agentBrowser/relay/browserView/protocol';
import { createDebuggerSessions, type DebuggerSessions } from '@process/services/agentBrowser/relay/debuggerSessions';
import { createTargetRegistry, type TargetRegistry } from '@process/services/agentBrowser/relay/targetRegistry';
import { FakeContents } from '../fakes';

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
const acks = (): number => sent('Page.screencastFrameAck').length;
/** The JSON meta of a wire frame (see encodeFrame): 4-byte big-endian header length, then the header. */
const metaOf = (b: Buffer): Record<string, number> => JSON.parse(b.subarray(4, 4 + b.readUInt32BE(0)).toString('utf8'));

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

const hello = (handle: Handle, width = 390, dpr = 3): void => send(handle, { type: 'hello', width, dpr });
const casting = async (tabId = 'wc-7', width = 390, dpr = 3) => {
  const s = await stream(tabId);
  hello(s.handle, width, dpr);
  return s;
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
    expect(service.listTabs('conv-1')).toEqual([{ id: 'wc-7', title: 'Example', url: 'https://example.com/' }]);
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
    expect(peer.texts[0]).toEqual({ type: 'tab', title: 'Example', url: 'https://example.com/' });
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
    expect(metaOf(peer.frames[0])).toEqual({
      offsetTop: 0,
      pageScaleFactor: 2,
      deviceWidth: 400,
      deviceHeight: 800,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    });
    expect(sent('Page.screencastFrameAck')).toHaveLength(0);

    send(handle, { type: 'ack' });
    expect(sent('Page.screencastFrameAck').map((c) => c.params)).toEqual([{ sessionId: 1 }, { sessionId: 1 }]);
    expect(peer.frames).toHaveLength(2);
    expect(metaOf(peer.frames[1]).scrollOffsetY).toBe(50);
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

  it('tap moves, presses and releases at the mapped point', async () => {
    const { handle } = await streaming();
    send(handle, { type: 'tap', nx: 0.5, ny: 0.25 });
    expect(sent('Input.dispatchMouseEvent').map((c) => c.params)).toEqual([
      { type: 'mouseMoved', x: 100, y: 100 },
      { type: 'mousePressed', x: 100, y: 100, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 100, y: 100, button: 'left', clickCount: 1 },
    ]);
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

  it('sends a non-text key as rawKeyDown, as the agent does', async () => {
    const { handle } = await streaming();
    send(handle, { type: 'key', key: 'Backspace' });
    expect(sent('Input.dispatchKeyEvent').map((c) => c.params)).toEqual([
      { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    ]);
  });

  it('turns focus emulation on once per tab, so typed text reaches an unfocused page', async () => {
    await stream('wc-7');
    await stream('wc-7');
    expect(sent('Emulation.setFocusEmulationEnabled').map((c) => c.params)).toEqual([{ enabled: true }]);
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
});

describe('browser view: registry changes', () => {
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
    expect(peer.texts.at(-1)).toEqual({ type: 'tab', title: 'Next', url: 'https://example.com/next' });
    const count = peer.texts.length;
    vi.advanceTimersByTime(3000);
    expect(peer.texts).toHaveLength(count);
  });
});

describe('browser view: back-pressure (owed acks)', () => {
  it('owes every frame until a phone acks, then acks them all and forwards the newest', async () => {
    const { handle, peer } = await casting();
    frame(tab, { ...META, scrollOffsetY: 1 });
    frame(tab, { ...META, scrollOffsetY: 2 });
    frame(tab, { ...META, scrollOffsetY: 3 });
    expect(acks()).toBe(0);
    expect(peer.frames).toHaveLength(1);

    send(handle, { type: 'ack' });

    expect(acks()).toBe(3);
    expect(peer.frames).toHaveLength(2);
    expect(metaOf(peer.frames[1]).scrollOffsetY).toBe(3);
  });

  it('the fastest phone paces; the slow one never causes a CDP ack', async () => {
    const fast = await casting();
    const slow = await casting();
    frame(tab, { ...META, scrollOffsetY: 1 });
    expect(slow.peer.frames).toHaveLength(1);

    send(fast.handle, { type: 'ack' });
    expect(acks()).toBe(1);
    frame(tab, { ...META, scrollOffsetY: 2 });
    expect(fast.peer.frames).toHaveLength(2);

    send(slow.handle, { type: 'ack' });
    expect(acks()).toBe(1);
    expect(metaOf(slow.peer.frames[1]).scrollOffsetY).toBe(2);

    send(fast.handle, { type: 'ack' });
    expect(acks()).toBe(2);
    send(slow.handle, { type: 'ack' });
    expect(acks()).toBe(2);
  });

  it('a stream that never said hello gets no frames and sends no acks', async () => {
    const idle = await stream('wc-7');
    await casting();
    frame(tab);
    send(idle.handle, { type: 'ack' });
    expect(idle.peer.frames).toHaveLength(0);
    expect(acks()).toBe(0);
  });

  it('owed acks go out once when the pacing stream leaves and another phone acks', async () => {
    const first = await casting();
    const second = await casting();
    frame(tab, { ...META, scrollOffsetY: 1 });
    frame(tab, { ...META, scrollOffsetY: 2 });

    first.handle.close();
    expect(acks()).toBe(0);
    send(second.handle, { type: 'ack' });
    expect(acks()).toBe(2);
    send(second.handle, { type: 'ack' });
    expect(acks()).toBe(2);
  });

  it('the last casting stream leaving acks what is owed once, then stops', async () => {
    const { handle } = await casting();
    frame(tab);
    frame(tab);
    handle.close();
    expect(acks()).toBe(2);
    expect(sent('Page.stopScreencast')).toHaveLength(1);
  });
});

describe('browser view: screencast width and stop', () => {
  it('casts at the widest phone and restarts only when that changes', async () => {
    const a = await casting('wc-7', 390, 3);
    const b = await casting('wc-7', 300, 2);
    b.handle.close();
    const c = await casting('wc-7', 800, 2);
    c.handle.close();
    expect(a).toBeDefined();
    expect(sent('Page.startScreencast').map((x) => x.params.maxWidth)).toEqual([1170, 1280, 1170]);
  });

  it('stops when no casting stream remains, even with a non-casting one open', async () => {
    const idle = await stream('wc-7');
    const { handle } = await casting();
    handle.close();
    expect(sent('Page.stopScreencast')).toHaveLength(1);
    expect(idle.peer.closes).toHaveLength(0);
  });
});

describe('browser view: lifecycle', () => {
  it('a debugger detaching during the attach refuses the stream as tab-closed', async () => {
    tab.debugger.handler = (method) => {
      if (method !== 'Page.enable') return {};
      tab.debugger.attached = false;
      tab.debugger.emit('detach', {}, 'target closed');
      return {};
    };
    const peer = new FakePeer();
    expect(await service.openStream('wc-7', peer)).toEqual({ error: 'tab-closed' });
    expect(peer.texts).toEqual([]);

    tab.debugger.handler = () => ({});
    const again = await stream('wc-7');
    expect(again.peer.texts[0]).toMatchObject({ type: 'tab' });
  });

  it('closeAll ends every stream and detaches its session', async () => {
    const { peer } = await casting();
    service.closeAll('not-allowed');
    expect(peer.texts.at(-1)).toEqual({ type: 'closed', reason: 'not-allowed' });
    expect(peer.closes).toHaveLength(1);
    expect(tab.debugger.isAttached()).toBe(false);
  });
});

describe('browser view: owed acks across joins and restarts', () => {
  it('a phone joining while acks are owed sends them once with its first ack, never twice', async () => {
    const first = await casting();
    frame(tab, { ...META, scrollOffsetY: 1 });
    frame(tab, { ...META, scrollOffsetY: 2 });
    const late = await casting();
    expect(metaOf(late.peer.frames[0]).scrollOffsetY).toBe(2);

    send(late.handle, { type: 'ack' });
    expect(acks()).toBe(2);
    send(first.handle, { type: 'ack' });
    send(first.handle, { type: 'ack' });
    send(late.handle, { type: 'ack' });
    expect(acks()).toBe(2);
  });

  it('a width change while acks are owed still sends them exactly once', async () => {
    const first = await casting('wc-7', 390, 3);
    frame(tab);
    frame(tab);
    const wide = await casting('wc-7', 900, 2);
    expect(sent('Page.startScreencast').map((x) => x.params.maxWidth)).toEqual([1170, 1280]);
    expect(acks()).toBe(0);

    send(first.handle, { type: 'ack' });
    expect(acks()).toBe(2);
    send(wide.handle, { type: 'ack' });
    send(first.handle, { type: 'ack' });
    expect(acks()).toBe(2);
  });

  it('after the last phone leaves, a new viewer gets a fresh cast', async () => {
    const old = await casting();
    frame(tab);
    frame(tab);
    old.handle.close();
    expect(tab.debugger.isAttached()).toBe(false);
    const acksBefore = acks();
    const enables = sent('Page.enable').length;

    const fresh = await casting('wc-7', 300, 2);
    expect(tab.debugger.isAttached()).toBe(true);
    expect(sent('Page.enable')).toHaveLength(enables + 1);
    expect(sent('Page.startScreencast').at(-1)?.params.maxWidth).toBe(600);
    frame(tab);
    expect(fresh.peer.frames).toHaveLength(1);
    send(fresh.handle, { type: 'ack' });
    expect(acks()).toBe(acksBefore + 1);
  });
});

describe('browser view: closing while attaching', () => {
  it('closeAll during a pending attach refuses the stream, starts no screencast and detaches', async () => {
    const setup = Promise.withResolvers<object>();
    tab.debugger.handler = (method) => (method === 'Page.enable' ? setup.promise : {});
    const peer = new FakePeer();
    const opening = service.openStream('wc-7', peer);
    await Promise.resolve();

    service.closeAll('not-allowed');
    setup.resolve({});

    expect(await opening).toMatchObject({ error: expect.any(String) });
    expect(sent('Page.startScreencast')).toHaveLength(0);
    expect(tab.debugger.isAttached()).toBe(false);
    expect(peer.texts).toEqual([]);
  });
});
