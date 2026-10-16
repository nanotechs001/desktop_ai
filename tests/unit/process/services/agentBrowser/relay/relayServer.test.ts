import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { AgentActionEvent } from '@/common/types/browser';
import { startRelayServer, type RelayHandle } from '@process/services/agentBrowser/relay/relayServer';
import { createTargetRegistry, type TargetRegistry } from '@process/services/agentBrowser/relay/targetRegistry';
import { FakeContents } from './fakes';

type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/** A raw ws CDP client that collects every event and pairs replies by id. */
class TestClient {
  readonly events: Message[] = [];
  private nextId = 1;
  private readonly waiting = new Map<number, (m: Message) => void>();
  private readonly eventWaiters: Array<{ match: (m: Message) => boolean; resolve: (m: Message) => void }> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Message;
      if (msg.id !== undefined) {
        this.waiting.get(msg.id)?.(msg);
        this.waiting.delete(msg.id);
        return;
      }
      this.events.push(msg);
      const index = this.eventWaiters.findIndex((w) => w.match(msg));
      if (index >= 0) this.eventWaiters.splice(index, 1)[0].resolve(msg);
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, id = this.nextId++): Promise<Message> {
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  waitForEvent(method: string, sessionId?: string): Promise<Message> {
    const match = (m: Message) => m.method === method && (sessionId === undefined || m.sessionId === sessionId);
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.eventWaiters.push({ match, resolve }));
  }
}

let relay: RelayHandle | null = null;
let registry: TargetRegistry;
const sockets: WebSocket[] = [];
const openTab = vi.fn();
const closeTab = vi.fn();
const onAgentAction = vi.fn<(event: AgentActionEvent) => void>();
let nextTab: Promise<FakeContents> = new Promise(() => {});

const start = async (): Promise<RelayHandle> => {
  registry = createTargetRegistry();
  relay = await startRelayServer({ registry, openTab, closeTab, onAgentAction, waitForTab: () => nextTab });
  return relay;
};

const wsUrl = (handle: RelayHandle, query: Record<string, string>): string => {
  const url = new URL(handle.url);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
};

const connect = async (handle: RelayHandle, label = 'claude'): Promise<TestClient> => {
  const ws = new WebSocket(wsUrl(handle, { token: handle.token, client: label }));
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return new TestClient(ws);
};

/** Status code of a refused upgrade. */
const refusedStatus = (url: string, headers: Record<string, string> = {}): Promise<number> =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => resolve(101));
    ws.on('error', () => {});
  });

/** A tab the relay knows about and `client` owns (as if it had opened it). */
const ownedTab = (id: number, clientLabel: string): FakeContents => {
  const contents = new FakeContents(id);
  registry.track(contents);
  const client = relay?.clients().find((c) => c.label === clientLabel);
  if (!client) throw new Error(`no client ${clientLabel}`);
  registry.claim(id, client);
  return contents;
};

const attach = async (client: TestClient, id: number): Promise<string> => {
  const reply = await client.send('Target.attachToTarget', { targetId: `wc-${id}`, flatten: true });
  expect(reply.error).toBeUndefined();
  return String(reply.result?.sessionId);
};

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await relay?.close();
  relay = null;
  vi.clearAllMocks();
  nextTab = new Promise(() => {});
});

describe('relay server: transport security', () => {
  it('401 without token; 403 with Origin; HTTP GET /json/version → 404', async () => {
    const handle = await start();
    expect(await refusedStatus(handle.url)).toBe(401);
    expect(await refusedStatus(wsUrl(handle, { token: 'wrong' }))).toBe(401);
    expect(await refusedStatus(wsUrl(handle, { token: handle.token }), { Origin: 'https://evil.example' })).toBe(403);
    expect(await refusedStatus(wsUrl(handle, { token: handle.token }))).toBe(101);

    const httpUrl = new URL(handle.url);
    httpUrl.protocol = 'http:';
    const responses = await Promise.all(
      ['/json/version', '/json/list', '/'].map(async (path) => {
        const res = await fetch(new URL(path, httpUrl));
        return { status: res.status, body: await res.text() };
      })
    );
    for (const { status, body } of responses) {
      expect(status).toBe(404);
      expect(body).not.toContain(handle.token);
    }
  });

  it('binds to 127.0.0.1', async () => {
    const handle = await start();
    expect(new URL(handle.url).hostname).toBe('127.0.0.1');
  });
});

describe('relay server: targets', () => {
  it('Target.createTarget emits openTabRequested, resolves with wc-<id> of the next attached browser webview, claims it', async () => {
    const handle = await start();
    const client = await connect(handle, 'my agent!');
    const tab = new FakeContents(41);
    nextTab = Promise.resolve(tab).then((contents) => {
      registry.track(contents);
      return contents;
    });

    const reply = await client.send('Target.createTarget', { url: 'https://example.com' });

    expect(openTab).toHaveBeenCalledWith('https://example.com');
    expect(reply.result).toEqual({ targetId: 'wc-41' });
    expect(registry.ownership(41)?.owner).toMatchObject({ label: 'my agent' });
  });

  it('Target.createTarget refuses non-web, metadata and app-internal urls without opening anything', async () => {
    const handle = await start();
    const client = await connect(handle);
    const replies = await Promise.all(
      [
        'javascript:alert(1)',
        'file:///etc/passwd',
        'chrome://settings',
        'http://169.254.169.254/latest/meta-data/',
        `http://127.0.0.1:${new URL(handle.url).port}/`,
      ].map((url) => client.send('Target.createTarget', { url }))
    );
    for (const reply of replies) expect(reply.error?.message).toMatch(/url/i);
    expect(openTab).not.toHaveBeenCalled();
  });

  it('Target.getTargets lists only browser webviews/popups the client may act on, never the main window', async () => {
    const handle = await start();
    const client = await connect(handle);
    ownedTab(1, 'claude');
    registry.track(new FakeContents(2)); // a private user tab
    registry.track(new FakeContents(3));
    registry.share(3, true);

    const reply = await client.send('Target.getTargets');
    const targetInfos = (reply.result?.targetInfos ?? []) as Array<{ targetId: string }>;
    expect(targetInfos.map((t) => t.targetId).toSorted()).toEqual(['wc-1', 'wc-3']);

    // The main window (or any webContents the registry does not track) is not a target at all.
    const mainWindow = await client.send('Target.attachToTarget', { targetId: 'wc-999', flatten: true });
    expect(mainWindow.error?.message).toMatch(/no such target/i);
    const userTab = await client.send('Target.attachToTarget', { targetId: 'wc-2', flatten: true });
    expect(userTab.error?.message).toMatch(/not shared/i);
  });

  it('Target.closeTarget closes only tabs the client owns', async () => {
    const handle = await start();
    const client = await connect(handle);
    ownedTab(1, 'claude');
    registry.track(new FakeContents(2));
    registry.share(2, true);

    expect((await client.send('Target.closeTarget', { targetId: 'wc-1' })).result).toEqual({ success: true });
    expect(closeTab).toHaveBeenCalledWith(1);
    expect((await client.send('Target.closeTarget', { targetId: 'wc-2' })).error).toBeDefined();
    expect(closeTab).toHaveBeenCalledTimes(1);
  });
});

describe('relay server: sessions', () => {
  it('routes child (OOPIF) session commands and events with the right sessionIds', async () => {
    const handle = await start();
    const client = await connect(handle);
    const tab = ownedTab(5, 'claude');
    const dbg = tab.debugger;

    const top = await attach(client, 5);
    expect(dbg.sendCommand).toHaveBeenCalledWith('Target.setAutoAttach', {
      autoAttach: true,
      flatten: true,
      waitForDebuggerOnStart: false,
    });

    dbg.message('Target.attachedToTarget', {
      sessionId: 'CDP-CHILD',
      targetInfo: { targetId: 'FRAME1', type: 'iframe', url: 'https://other.example/' },
      waitingForDebugger: false,
    });
    const attached = await client.waitForEvent('Target.attachedToTarget');
    expect(attached.sessionId).toBe(top);
    const child = String(attached.params?.sessionId);
    expect(child).not.toBe(top);
    expect(attached.params?.targetInfo).toMatchObject({ targetId: 'FRAME1' });
    // Nested OOPIFs: auto-attach is re-issued on each child session.
    expect(dbg.sendCommand).toHaveBeenCalledWith(
      'Target.setAutoAttach',
      { autoAttach: true, flatten: true, waitForDebuggerOnStart: false },
      'CDP-CHILD'
    );

    dbg.handler = (method, _params, sessionId) => ({ method, sessionId: sessionId ?? 'top' });
    expect((await client.send('Page.getFrameTree', {}, child)).result).toEqual({
      method: 'Page.getFrameTree',
      sessionId: 'CDP-CHILD',
    });
    expect((await client.send('Page.getFrameTree', {}, top)).result).toEqual({
      method: 'Page.getFrameTree',
      sessionId: 'top',
    });

    dbg.message('Page.frameNavigated', { frame: { id: 'FRAME1' } }, 'CDP-CHILD');
    dbg.message('Page.loadEventFired', {}, '');
    expect((await client.waitForEvent('Page.frameNavigated')).sessionId).toBe(child);
    expect((await client.waitForEvent('Page.loadEventFired')).sessionId).toBe(top);

    dbg.message('Target.detachedFromTarget', { sessionId: 'CDP-CHILD', targetId: 'FRAME1' });
    const detached = await client.waitForEvent('Target.detachedFromTarget');
    expect(detached).toMatchObject({ sessionId: top, params: { sessionId: child } });
    expect((await client.send('Page.getFrameTree', {}, child)).error?.message).toMatch(/unknown sessionId/i);
  });

  it('replays existing OOPIF children to a second client attaching a shared tab', async () => {
    const handle = await start();
    const a = await connect(handle, 'a');
    const b = await connect(handle, 'b');
    const tab = ownedTab(5, 'a');
    registry.share(5, true);
    await attach(a, 5);
    tab.debugger.message('Target.attachedToTarget', {
      sessionId: 'CDP-CHILD',
      targetInfo: { targetId: 'F', type: 'iframe' },
    });
    await a.waitForEvent('Target.attachedToTarget');

    const topB = await attach(b, 5);
    const replayed = await b.waitForEvent('Target.attachedToTarget');
    expect(replayed.sessionId).toBe(topB);
    expect(replayed.params?.targetInfo).toMatchObject({ targetId: 'F' });
  });

  it('an attach error is replied with its message and other tabs keep working', async () => {
    const handle = await start();
    const client = await connect(handle);
    const broken = ownedTab(6, 'claude');
    broken.debugger.attachError = 'Debugger is already attached to the target';
    ownedTab(7, 'claude');

    const failed = await client.send('Target.attachToTarget', { targetId: 'wc-6', flatten: true });
    expect(failed.error?.message).toContain('Debugger is already attached to the target');

    const session = await attach(client, 7);
    expect((await client.send('Page.getFrameTree', {}, session)).error).toBeUndefined();
  });

  it('a destroyed webContents emits Target.targetDestroyed and drops its sessions', async () => {
    const handle = await start();
    const client = await connect(handle);
    const tab = ownedTab(8, 'claude');
    const session = await attach(client, 8);

    tab.destroy();

    expect((await client.waitForEvent('Target.targetDestroyed')).params).toEqual({ targetId: 'wc-8' });
    expect((await client.waitForEvent('Target.detachedFromTarget')).params).toMatchObject({ sessionId: session });
    expect((await client.send('Page.getFrameTree', {}, session)).error?.message).toMatch(/unknown sessionId/i);
  });

  it('two clients using id 1 get their own replies; events go only to the attaching client', async () => {
    const handle = await start();
    const a = await connect(handle, 'a');
    const b = await connect(handle, 'b');
    const tabA = ownedTab(10, 'a');
    ownedTab(11, 'b');
    tabA.debugger.handler = () => ({ from: 'a' });
    const sessionA = await attach(a, 10);
    const sessionB = await attach(b, 11);

    const [replyA, replyB] = await Promise.all([
      a.send('Page.getFrameTree', {}, sessionA, 1),
      b.send('Page.getFrameTree', {}, sessionB, 1),
    ]);
    expect(replyA).toMatchObject({ id: 1, result: { from: 'a' }, sessionId: sessionA });
    expect(replyB).toMatchObject({ id: 1, result: {}, sessionId: sessionB });

    tabA.debugger.message('Page.loadEventFired', {});
    await a.waitForEvent('Page.loadEventFired');
    await b.send('Target.getTargets'); // a round trip, so a stray event would have arrived by now
    expect(b.events.some((e) => e.method === 'Page.loadEventFired')).toBe(false);

    // B cannot use A's session id.
    expect((await b.send('Page.getFrameTree', {}, sessionA)).error?.message).toMatch(/unknown sessionId/i);
  });

  it('enforces the policy on session commands and tracks own isolated worlds', async () => {
    const handle = await start();
    const client = await connect(handle);
    const tab = ownedTab(12, 'claude');
    const session = await attach(client, 12);
    tab.debugger.handler = (method) => (method === 'Page.createIsolatedWorld' ? { executionContextId: 77 } : {});

    expect((await client.send('Network.getAllCookies', {}, session)).error?.message).toContain('not allowed');
    expect((await client.send('Runtime.evaluate', { expression: '1', contextId: 77 }, session)).error).toBeDefined();
    await client.send('Page.createIsolatedWorld', { frameId: 'F', worldName: 'aion' }, session);
    expect((await client.send('Runtime.evaluate', { expression: '1', contextId: 77 }, session)).error).toBeUndefined();

    registry.setPaused(12, true);
    expect((await client.send('Input.insertText', { text: 'x' }, session)).error?.message).toContain('user took over');
    expect(tab.debugger.sendCommand).not.toHaveBeenCalledWith('Input.insertText', expect.anything());
  });

  it('forgets own isolated worlds when the top frame navigates to a new document', async () => {
    const handle = await start();
    const client = await connect(handle);
    const tab = ownedTab(16, 'claude');
    const session = await attach(client, 16);
    // The relay enables Page itself so it sees navigations even when the client did not.
    expect(tab.debugger.sendCommand).toHaveBeenCalledWith('Page.enable', {});
    tab.debugger.handler = (method) => (method === 'Page.createIsolatedWorld' ? { executionContextId: 5 } : {});
    await client.send('Page.createIsolatedWorld', { frameId: 'F', worldName: 'aion' }, session);
    const evaluate = { expression: '1', contextId: 5 };

    tab.debugger.message('Page.frameNavigated', { frame: { id: 'SUB', parentId: 'F', url: 'https://x/' } });
    await client.waitForEvent('Page.frameNavigated');
    expect((await client.send('Runtime.evaluate', evaluate, session)).error).toBeUndefined();

    tab.debugger.message('Page.frameNavigated', { frame: { id: 'F', url: 'https://example.com/next' } });
    await vi.waitFor(() => expect(client.events.filter((e) => e.method === 'Page.frameNavigated')).toHaveLength(2));
    expect((await client.send('Runtime.evaluate', evaluate, session)).error?.message).toMatch(/isolated-world/);
  });

  it('Page.reload reloads the tab itself, never through CDP (which would reload the AionUi window)', async () => {
    const handle = await start();
    const client = await connect(handle);
    const tab = ownedTab(17, 'claude');
    const session = await attach(client, 17);

    await client.send('Page.reload', {}, session);
    await client.send('Page.reload', { ignoreCache: true }, session);

    expect(tab.reload).toHaveBeenCalledTimes(1);
    expect(tab.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(tab.debugger.sendCommand).not.toHaveBeenCalledWith('Page.reload', expect.anything());
    expect((await client.send('Page.reload', { scriptToEvaluateOnLoad: 'x' }, session)).error).toBeDefined();
  });

  it('marks agent input in flight so its own mouse events do not pause the tab', async () => {
    const handle = await start();
    const client = await connect(handle);
    const tab = ownedTab(13, 'claude');
    const session = await attach(client, 13);
    // Electron fires before-mouse-event for CDP mouse input while the command is pending.
    tab.debugger.handler = () => {
      registry.noteUserInput(13);
      return {};
    };
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }, session);
    expect(registry.ownership(13)?.paused).toBe(false);
  });

  it('unsharing a user tab detaches agent sessions on it', async () => {
    const handle = await start();
    const client = await connect(handle);
    registry.track(new FakeContents(14));
    registry.share(14, true);
    const session = await attach(client, 14);

    registry.share(14, false);

    expect((await client.waitForEvent('Target.detachedFromTarget')).params).toMatchObject({ sessionId: session });
    expect((await client.send('Page.getFrameTree', {}, session)).error).toBeDefined();
  });

  it('a disconnected client keeps its tabs open, relabelled, and releases the debugger', async () => {
    const handle = await start();
    const client = await connect(handle);
    const tab = ownedTab(15, 'claude');
    await attach(client, 15);
    expect(tab.debugger.isAttached()).toBe(true);

    client.ws.close();
    await vi.waitFor(() => expect(handle.clients()).toEqual([]));

    expect(registry.ownership(15)?.owner).toMatchObject({ label: 'agent (disconnected)' });
    expect(tab.debugger.isAttached()).toBe(false);
    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe('relay server: AionRelay methods', () => {
  it('re-emits reportAction as an agent action, rate-limited per client', async () => {
    const handle = await start();
    const client = await connect(handle);
    ownedTab(20, 'claude');
    const action = { webContentsId: 20, op: 'click', label: 'Save', rect: { x: 1, y: 2, width: 3, height: 4 } };

    expect((await client.send('AionRelay.reportAction', action)).error).toBeUndefined();
    expect(onAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ ...action, clientLabel: 'claude', at: expect.any(Number) })
    );

    const replies = await Promise.all(Array.from({ length: 25 }, () => client.send('AionRelay.reportAction', action)));
    expect(replies.filter((r) => r.error).length).toBeGreaterThan(0);
    expect(onAgentAction.mock.calls.length).toBeLessThanOrEqual(20);
  });

  it('reportAction refuses a tab the client may not act on, and malformed input', async () => {
    const handle = await start();
    const client = await connect(handle);
    registry.track(new FakeContents(21));
    expect(
      (await client.send('AionRelay.reportAction', { webContentsId: 21, op: 'click', label: '', rect: null })).error
    ).toBeDefined();
    ownedTab(22, 'claude');
    expect(
      (await client.send('AionRelay.reportAction', { webContentsId: 22, op: 5, label: 'x', rect: null })).error
    ).toBeDefined();
    expect(onAgentAction).not.toHaveBeenCalled();
  });

  it('requestConfirm is allowed until the confirm gate lands', async () => {
    const client = await connect(await start());
    expect((await client.send('AionRelay.requestConfirm', { webContentsId: 1, summary: 'x' })).result).toEqual({
      allow: true,
    });
  });
});
