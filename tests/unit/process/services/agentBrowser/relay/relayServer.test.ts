import { connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { RelayLimits } from '@process/services/agentBrowser/relay/relayTransport';
import { createDebuggerSessions, type DebuggerSessions } from '@process/services/agentBrowser/relay/debuggerSessions';
import type { AgentActionEvent, BrowserTabProfile, ConfirmRequest } from '@/common/types/browser';
import { startRelayServer, type RelayHandle } from '@process/services/agentBrowser/relay/relayServer';
import {
  createTargetRegistry,
  type RelayClient,
  type TargetRegistry,
} from '@process/services/agentBrowser/relay/targetRegistry';
import { FakeContents } from './fakes';

type ConfirmAsk = Omit<ConfirmRequest, 'id'>;

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
const requestConfirm =
  vi.fn<(req: ConfirmAsk, signal: AbortSignal, webContentsId: number, yoloChat?: string) => Promise<boolean>>();
let nextTab: () => Promise<FakeContents> = () => new Promise(() => {});
const waitForTab = vi.fn((_url: string, _conversationId?: string, _profile?: BrowserTabProfile) => nextTab());
/** Main's conversation → Agent lookup: each chat its own Agent, no chat the default Agent. */
const agentProfileOf = (conversationId?: string): BrowserTabProfile => ({
  kind: 'agent',
  agentId: conversationId ? `agent-of-${conversationId}` : 'aion-default-agent',
});
const resolveProfile = vi.fn(async (conversationId?: string) => ({
  profile: agentProfileOf(conversationId),
  final: true,
}));

const start = async (limits: Partial<RelayLimits> = {}, sessions?: DebuggerSessions): Promise<RelayHandle> => {
  registry = createTargetRegistry();
  relay = await startRelayServer({
    registry,
    sessions,
    openTab,
    closeTab,
    onAgentAction,
    requestConfirm,
    waitForTab,
    resolveProfile,
    limits,
  });
  return relay;
};

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

const wsUrl = (handle: RelayHandle, query: Record<string, string>): string => {
  const url = new URL(handle.url);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
};

const connect = async (
  handle: RelayHandle,
  label = 'claude',
  headers: Record<string, string> = {}
): Promise<TestClient> => {
  const ws = new WebSocket(wsUrl(handle, { client: label }), { headers: { ...bearer(handle.token), ...headers } });
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
  vi.restoreAllMocks();
  nextTab = () => new Promise(() => {});
});

/** Raw HTTP upgrade, for request shapes the ws client cannot produce. */
const rawUpgradeStatus = (handle: RelayHandle, path: string): Promise<string> =>
  new Promise((resolve) => {
    const { port } = new URL(handle.url);
    const socket = netConnect(Number(port), '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          `Authorization: Bearer ${handle.token}\r\n\r\n`
      );
    });
    socket.once('data', (data) => {
      resolve(data.toString().split('\r\n')[0]);
      socket.destroy();
    });
    socket.on('error', () => resolve('error'));
  });

describe('relay server: transport security', () => {
  it('401 without token; 403 with Origin; HTTP GET /json/version → 404', async () => {
    const handle = await start();
    expect(await refusedStatus(handle.url)).toBe(401);
    expect(await refusedStatus(handle.url, bearer('wrong'))).toBe(401);
    // The token travels only in the Authorization header now, never in the url.
    expect(await refusedStatus(wsUrl(handle, { token: handle.token }))).toBe(401);
    // Origin is checked first: a page gets 403 whatever else it sends.
    expect(await refusedStatus(handle.url, { Origin: 'https://evil.example' })).toBe(403);
    expect(await refusedStatus(handle.url, { ...bearer(handle.token), Origin: 'https://evil.example' })).toBe(403);
    expect(await refusedStatus(handle.url, bearer(handle.token))).toBe(101);

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

  it('refuses a foreign Host header (DNS rebinding) and an unparsable url', async () => {
    const handle = await start();
    expect(
      await refusedStatus(handle.url, { ...bearer(handle.token), Host: `evil.example:${new URL(handle.url).port}` })
    ).toBe(403);
    expect(await rawUpgradeStatus(handle, '//[')).toContain('400');
    expect(await rawUpgradeStatus(handle, '/?client=ok')).toContain('101');
  });

  it('accepts at most 32 connections', async () => {
    const handle = await start();
    await Promise.all(Array.from({ length: 32 }, (_, i) => connect(handle, `c${i}`)));
    expect(await refusedStatus(handle.url, bearer(handle.token))).toBe(503);
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
    nextTab = () => {
      registry.track(tab);
      return Promise.resolve(tab);
    };

    const reply = await client.send('Target.createTarget', { url: 'https://example.com' });

    expect(openTab).toHaveBeenCalledWith('https://example.com', undefined, agentProfileOf());
    expect(reply.result).toEqual({ targetId: 'wc-41' });
    expect(registry.ownership(41)?.owner).toMatchObject({ label: 'my agent' });
  });

  it("Target.createTarget names the client's chat (X-Aion-Conversation) to the pane; none when absent or malformed", async () => {
    const handle = await start();
    let nextId = 50;
    nextTab = () => {
      const tab = new FakeContents(nextId++);
      registry.track(tab);
      return Promise.resolve(tab);
    };
    const named = await connect(handle, 'a', { 'X-Aion-Conversation': 'conv_A-1' });
    const plain = await connect(handle, 'b');
    const malformed = await connect(handle, 'c', { 'X-Aion-Conversation': 'conv/../x' });

    const create = (client: TestClient) => client.send('Target.createTarget', { url: 'https://example.com' });
    expect((await create(named)).error).toBeUndefined();
    expect((await create(plain)).error).toBeUndefined();
    expect((await create(malformed)).error).toBeUndefined();

    expect(openTab.mock.calls).toEqual([
      ['https://example.com', 'conv_A-1', agentProfileOf('conv_A-1')],
      ['https://example.com', undefined, agentProfileOf()],
      ['https://example.com', undefined, agentProfileOf()],
    ]);
  });

  it("an agent tabs.open creates the tab in the chat's Agent profile, ignoring any profile in the tool input", async () => {
    const handle = await start();
    nextTab = () => {
      const tab = new FakeContents(60);
      registry.track(tab);
      return Promise.resolve(tab);
    };
    const client = await connect(handle, 'a', { 'X-Aion-Conversation': 'conv_A-1' });

    const reply = await client.send('Target.createTarget', {
      url: 'https://example.com',
      profile: { kind: 'personal' },
      browserContextId: 'persist:aionui-browser',
      partition: 'persist:aionui-browser',
    });

    expect(reply.error).toBeUndefined();
    expect(resolveProfile).toHaveBeenCalledWith('conv_A-1');
    expect(openTab).toHaveBeenCalledWith('https://example.com', 'conv_A-1', agentProfileOf('conv_A-1'));
    expect(waitForTab).toHaveBeenCalledWith('https://example.com', 'conv_A-1', agentProfileOf('conv_A-1'));
  });

  it('opens nothing while the Agent of the chat is unresolved, keeps other commands working, and retries after 10 s', async () => {
    const handle = await start();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveProfile.mockRejectedValueOnce(new Error('backend down'));
    const client = await connect(handle, 'a', { 'X-Aion-Conversation': 'conv_A-1' });

    const refused = await client.send('Target.createTarget', { url: 'https://example.com' });
    expect(refused.error?.message).toMatch(/profile is not known yet/);
    expect(openTab).not.toHaveBeenCalled();
    // The failed lookup does not fail every later command.
    expect((await client.send('Target.getTargets')).error).toBeUndefined();
    expect(resolveProfile).toHaveBeenCalledTimes(1);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10_001);
    nextTab = () => {
      const tab = new FakeContents(90);
      registry.track(tab);
      return Promise.resolve(tab);
    };
    expect((await client.send('Target.createTarget', { url: 'https://example.com' })).result).toEqual({
      targetId: 'wc-90',
    });
    expect(resolveProfile).toHaveBeenCalledTimes(2);
    expect(openTab).toHaveBeenCalledWith('https://example.com', 'conv_A-1', agentProfileOf('conv_A-1'));
  });

  it('retries a lookup that fell back to the default profile on an error, at most once per 10 s; never a final one', async () => {
    const handle = await start();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    resolveProfile.mockResolvedValueOnce({ profile: agentProfileOf(), final: false });
    const flaky = await connect(handle, 'a', { 'X-Aion-Conversation': 'conv_A-1' });
    const settled = await connect(handle, 'b', { 'X-Aion-Conversation': 'conv_B' });
    const lookupsOf = (id: string) => resolveProfile.mock.calls.filter(([c]) => c === id).length;

    await flaky.send('AionRelay.listTabs');
    await settled.send('AionRelay.listTabs');
    clock.mockReturnValue(now + 5_000);
    await flaky.send('AionRelay.listTabs');
    expect(lookupsOf('conv_A-1')).toBe(1);

    clock.mockReturnValue(now + 10_001);
    await flaky.send('AionRelay.listTabs');
    await flaky.send('AionRelay.listTabs');
    await settled.send('AionRelay.listTabs');
    expect(lookupsOf('conv_A-1')).toBe(2);
    expect(lookupsOf('conv_B')).toBe(1);

    // The retried lookup's profile is the one now in use: the chat's own Agent's shared tab is reachable.
    registry.track(new FakeContents(91), agentProfileOf('conv_A-1'));
    registry.share(91, true);
    const tabs = (await flaky.send('AionRelay.listTabs')).result?.tabs as Array<{ targetId: string }>;
    expect(tabs.map((t) => t.targetId)).toEqual(['wc-91']);
  });

  it("a shared tab in Agent X's profile reaches only X's clients; a shared Personal tab reaches every client", async () => {
    const handle = await start();
    const agentX = await connect(handle, 'x', { 'X-Aion-Conversation': 'conv_X' });
    const agentY = await connect(handle, 'y', { 'X-Aion-Conversation': 'conv_Y' });
    const noChat = await connect(handle, 'none');
    registry.track(new FakeContents(80), agentProfileOf('conv_X'));
    registry.track(new FakeContents(81), { kind: 'personal' });
    registry.track(new FakeContents(82), agentProfileOf());
    for (const id of [80, 81, 82]) registry.share(id, true);

    const listed = async (client: TestClient) =>
      (((await client.send('AionRelay.listTabs')).result?.tabs ?? []) as Array<{ targetId: string }>)
        .map((t) => t.targetId)
        .toSorted();
    const attachTo = (client: TestClient, targetId: string) =>
      client.send('Target.attachToTarget', { targetId, flatten: true });

    expect(await listed(agentX)).toEqual(['wc-80', 'wc-81']);
    expect((await attachTo(agentX, 'wc-80')).error).toBeUndefined();
    expect(await listed(agentY)).toEqual(['wc-81']);
    expect((await attachTo(agentY, 'wc-80')).error?.message).toMatch(/not shared/i);
    expect((await agentY.send('Target.closeTarget', { targetId: 'wc-80' })).error).toBeDefined();
    const targets = (await agentY.send('Target.getTargets')).result?.targetInfos as Array<{ targetId: string }>;
    expect(targets.map((t) => t.targetId)).toEqual(['wc-81']);
    expect((await attachTo(agentY, 'wc-81')).error).toBeUndefined();
    // A client with no chat is the default Agent's: among Agent profiles it reaches only the default one.
    expect(await listed(noChat)).toEqual(['wc-81', 'wc-82']);
    expect((await attachTo(noChat, 'wc-80')).error?.message).toMatch(/not shared/i);
    expect(registry.ownership(80)?.profile).toEqual(agentProfileOf('conv_X'));
    // The profile is resolved once per connection, not per command.
    expect(resolveProfile.mock.calls.filter(([id]) => id === 'conv_Y')).toHaveLength(1);
  });

  it("an agent cannot target a Personal tab unless shared, nor another Agent's tab", async () => {
    const handle = await start();
    nextTab = () => {
      const tab = new FakeContents(70);
      registry.track(tab);
      return Promise.resolve(tab);
    };
    const agentA = await connect(handle, 'a', { 'X-Aion-Conversation': 'conv_A' });
    const agentB = await connect(handle, 'b', { 'X-Aion-Conversation': 'conv_B' });
    expect((await agentA.send('Target.createTarget', { url: 'https://example.com' })).result).toEqual({
      targetId: 'wc-70',
    });
    registry.track(new FakeContents(71)); // the user's own Personal tab

    const listed = async (client: TestClient) =>
      (((await client.send('AionRelay.listTabs')).result?.tabs ?? []) as Array<{ targetId: string }>).map(
        (t) => t.targetId
      );
    const attachTo = (client: TestClient, targetId: string) =>
      client.send('Target.attachToTarget', { targetId, flatten: true });

    // Agent B sees neither Agent A's tab (in A's profile) nor the unshared Personal tab, and cannot reach them.
    expect(await listed(agentB)).toEqual([]);
    expect((await attachTo(agentB, 'wc-70')).error?.message).toMatch(/not shared/i);
    expect((await agentB.send('Target.closeTarget', { targetId: 'wc-70' })).error).toBeDefined();
    expect((await attachTo(agentB, 'wc-71')).error?.message).toMatch(/not shared/i);
    expect(await listed(agentA)).toEqual(['wc-70']);

    // Share is the only way into a Personal tab.
    registry.share(71, true);
    expect((await listed(agentB)).toSorted()).toEqual(['wc-71']);
    expect((await attachTo(agentB, 'wc-71')).error).toBeUndefined();
    expect((await attachTo(agentB, 'wc-70')).error?.message).toMatch(/not shared/i);
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
  it('AionRelay.listTabs lists the tabs this client may act on, labelled agent or shared', async () => {
    const handle = await start();
    const client = await connect(handle);
    ownedTab(30, 'claude');
    registry.track(new FakeContents(31)); // a private user tab
    registry.track(new FakeContents(32));
    registry.share(32, true);
    await connect(handle, 'other'); // another client's tab stays invisible
    ownedTab(33, 'other');

    const reply = await client.send('AionRelay.listTabs');
    expect(reply.error).toBeUndefined();
    expect(reply.result?.tabs).toEqual([
      { targetId: 'wc-30', title: 'Example', url: 'https://example.com/', owner: 'agent' },
      { targetId: 'wc-32', title: 'Example', url: 'https://example.com/', owner: 'shared' },
    ]);
  });

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

  it('reportAction clamps the label to 120 characters and the rect to non-negative numbers', async () => {
    const handle = await start();
    const client = await connect(handle);
    ownedTab(23, 'claude');
    const rect = { x: -5, y: 2, width: 3, height: -1 };
    await client.send('AionRelay.reportAction', { webContentsId: 23, op: 'type', label: 'L'.repeat(500), rect });
    expect(onAgentAction).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'L'.repeat(120), rect: { x: 0, y: 2, width: 3, height: 0 } })
    );
    const notFinite = { webContentsId: 23, op: 'type', label: 'x', rect: { x: 1, y: 1, width: null, height: 1 } };
    expect((await client.send('AionRelay.reportAction', notFinite)).error).toBeDefined();
  });

  describe('requestConfirm', () => {
    const TREE = {
      frameTree: {
        frame: { id: 'TOP', url: 'https://shop.test/cart?x=1#y', securityOrigin: 'https://shop.test' },
        childFrames: [
          { frame: { id: 'PAY', url: 'https://pay.test/card', securityOrigin: 'https://pay.test' } },
          { frame: { id: 'SANDBOX', url: 'https://pay.test/sandboxed', securityOrigin: '://' } },
          { frame: { id: 'SILENT', url: 'https://pay.test/silent' } },
        ],
      },
    };

    /** An agent-owned tab, an attached session, and `ask(…)` for the request the MCP would send. */
    const confirmTab = async (url = 'https://shop.test/cart?x=1#y', id = 40, conversationId?: string) => {
      const client = await connect(await start());
      const contents = new FakeContents(id, url);
      contents.debugger.handler = (method) => (method === 'Page.getFrameTree' ? TREE : {});
      registry.track(contents);
      registry.claim(id, { ...(relay?.clients()[0] as RelayClient), ...(conversationId ? { conversationId } : {}) });
      const sessionId = await attach(client, id);
      const ask = (patch: Record<string, unknown> = {}) =>
        client.send('AionRelay.requestConfirm', {
          webContentsId: id,
          label: 'Send',
          sessionId,
          frameId: 'TOP',
          ...patch,
        });
      return { client, contents, sessionId, ask };
    };

    it('asks with the tab and frame origins from its own state and a cleaned, bounded label', async () => {
      const { ask } = await confirmTab();
      requestConfirm.mockResolvedValueOnce(true);
      const label = `Pay\u202e\n now ${'x'.repeat(300)}`;
      const reply = await ask({ label, origin: 'https://evil.test', frameOrigin: 'https://evil.test' });
      expect(reply.result).toEqual({ allow: true });
      expect(requestConfirm.mock.calls[0][0]).toEqual({
        origin: 'https://shop.test',
        frameOrigin: 'https://shop.test',
        label: `Pay now ${'x'.repeat(112)}`,
        clientLabel: 'claude',
      });
      requestConfirm.mockResolvedValueOnce(false);
      expect((await ask()).result).toEqual({ allow: false });
    });

    it('names the chat that owns the tab, so the ask also shows there; none for a tab no chat owns', async () => {
      const { ask, client } = await confirmTab(undefined, 40, 'conv_A-1');
      requestConfirm.mockResolvedValue(true);
      await ask();
      expect(requestConfirm.mock.calls[0][0]).toMatchObject({
        origin: 'https://shop.test',
        conversationId: 'conv_A-1',
      });

      // A user tab shared with agents belongs to no chat: the ask stays on the browser pane only.
      const shared = new FakeContents(50, 'https://bank.test/');
      shared.debugger.handler = (method) =>
        method === 'Page.getFrameTree'
          ? { frameTree: { frame: { id: 'TOP', url: 'https://bank.test/', securityOrigin: 'https://bank.test' } } }
          : {};
      registry.track(shared);
      registry.share(50, true);
      const bankSession = await attach(client, 50);
      await client.send('AionRelay.requestConfirm', {
        webContentsId: 50,
        label: 'Send',
        sessionId: bankSession,
        frameId: 'TOP',
      });
      expect(requestConfirm.mock.calls[1][0]).not.toHaveProperty('conversationId');
    });

    it("names the asking agent's own chat first, so an ask on a shared user tab reaches that chat", async () => {
      const client = await connect(await start(), 'claude', { 'X-Aion-Conversation': 'conv_B-2' });
      const shared = new FakeContents(51, 'https://bank.test/');
      shared.debugger.handler = (method) =>
        method === 'Page.getFrameTree'
          ? { frameTree: { frame: { id: 'TOP', url: 'https://bank.test/', securityOrigin: 'https://bank.test' } } }
          : {};
      registry.track(shared);
      registry.share(51, true);
      // Shared Personal tabs are open to every client; the lookup has to finish before the attach.
      await client.send('AionRelay.listTabs');
      const sessionId = await attach(client, 51);
      requestConfirm.mockResolvedValue(true);
      await client.send('AionRelay.requestConfirm', { webContentsId: 51, label: 'Send', sessionId, frameId: 'TOP' });
      expect(requestConfirm.mock.calls[0][0]).toMatchObject({
        origin: 'https://bank.test',
        conversationId: 'conv_B-2',
      });
    });

    describe('which chat may answer by YOLO mode', () => {
      const bankTree = {
        frameTree: { frame: { id: 'TOP', url: 'https://bank.test/', securityOrigin: 'https://bank.test' } },
      };
      const yoloChatOfCall = (): unknown => requestConfirm.mock.calls[0][3];

      it("is never the tab owner's chat: a client with no chat header is always asked (R13)", async () => {
        const { ask } = await confirmTab(undefined, 40, 'conv_A-1');
        requestConfirm.mockResolvedValue(true);
        await ask();
        expect(requestConfirm.mock.calls[0][0]).toMatchObject({ conversationId: 'conv_A-1' }); // still shown there
        expect(yoloChatOfCall()).toBeUndefined();
      });

      const ownTab = async (shared: boolean) => {
        const client = await connect(await start(), 'claude', { 'X-Aion-Conversation': 'conv_B-2' });
        await client.send('AionRelay.listTabs');
        const contents = new FakeContents(52, 'https://bank.test/');
        contents.debugger.handler = (method) => (method === 'Page.getFrameTree' ? bankTree : {});
        registry.track(contents, agentProfileOf('conv_B-2'));
        registry.claim(52, { ...(relay?.clients()[0] as RelayClient), conversationId: 'conv_B-2' });
        if (shared) registry.share(52, true);
        const sessionId = await attach(client, 52);
        requestConfirm.mockResolvedValue(true);
        await client.send('AionRelay.requestConfirm', { webContentsId: 52, label: 'Send', sessionId, frameId: 'TOP' });
      };

      it("is the asking client's own chat on its own unshared agent tab", async () => {
        await ownTab(false);
        expect(yoloChatOfCall()).toBe('conv_B-2');
      });

      it('is none on its own agent tab once shared (R15)', async () => {
        await ownTab(true);
        expect(yoloChatOfCall()).toBeUndefined();
      });

      it('is none on a user tab shared with agents (R15)', async () => {
        const client = await connect(await start(), 'claude', { 'X-Aion-Conversation': 'conv_B-2' });
        const shared = new FakeContents(51, 'https://bank.test/');
        shared.debugger.handler = (method) => (method === 'Page.getFrameTree' ? bankTree : {});
        registry.track(shared);
        registry.share(51, true);
        await client.send('AionRelay.listTabs');
        const sessionId = await attach(client, 51);
        requestConfirm.mockResolvedValue(true);
        await client.send('AionRelay.requestConfirm', { webContentsId: 51, label: 'Send', sessionId, frameId: 'TOP' });
        expect(requestConfirm.mock.calls[0][0]).toMatchObject({ conversationId: 'conv_B-2' });
        expect(yoloChatOfCall()).toBeUndefined();
      });
    });

    it('takes the origin of a control in a cross-origin frame from the frame tree', async () => {
      const { ask } = await confirmTab();
      requestConfirm.mockResolvedValue(true);
      await ask({ frameId: 'PAY' });
      expect(requestConfirm.mock.calls[0][0]).toMatchObject({
        origin: 'https://shop.test',
        frameOrigin: 'https://pay.test',
      });
      // A frame the tree does not know, or one that reports no security origin, is a denial without asking.
      expect((await ask({ frameId: 'GONE' })).result).toEqual({ allow: false });
      expect((await ask({ frameId: 'SILENT' })).result).toEqual({ allow: false });
      expect(requestConfirm).toHaveBeenCalledTimes(1);
    });

    it('never lends a sandboxed frame the origin of its url: it is asked about as opaque', async () => {
      const { ask } = await confirmTab();
      requestConfirm.mockResolvedValue(true);
      await ask({ frameId: 'SANDBOX' });
      expect(requestConfirm.mock.calls[0][0]).toMatchObject({ origin: 'https://shop.test', frameOrigin: null });
    });

    it("cannot borrow another shared tab's origin through this client's session on a different tab", async () => {
      const { client, ask, sessionId } = await confirmTab();
      const shared = new FakeContents(50, 'https://bank.test/');
      shared.debugger.handler = (method) =>
        method === 'Page.getFrameTree'
          ? { frameTree: { frame: { id: 'TOP', url: 'https://bank.test/', securityOrigin: 'https://bank.test' } } }
          : {};
      registry.track(shared);
      registry.share(50, true);
      const bankSession = await attach(client, 50);
      // Each session works for its own tab, and for no other.
      requestConfirm.mockResolvedValue(true);
      await client.send('AionRelay.requestConfirm', {
        webContentsId: 50,
        label: 'Send',
        sessionId: bankSession,
        frameId: 'TOP',
      });
      expect(requestConfirm.mock.calls[0][0]).toMatchObject({ origin: 'https://bank.test' });
      const crossed = await Promise.all([
        ask({ sessionId: bankSession }),
        client.send('AionRelay.requestConfirm', { webContentsId: 50, label: 'Send', sessionId, frameId: 'TOP' }),
      ]);
      expect(crossed.map((reply) => reply.error?.message)).toEqual([
        expect.stringMatching(/Unknown sessionId/),
        expect.stringMatching(/Unknown sessionId/),
      ]);
      expect(requestConfirm).toHaveBeenCalledTimes(1);
    });

    it('uses the committed main-frame url, not a pending navigation', async () => {
      const { ask, contents } = await confirmTab();
      contents.pendingUrl = 'https://evil.test/';
      requestConfirm.mockResolvedValue(true);
      await ask();
      expect(requestConfirm.mock.calls[0][0]).toMatchObject({ origin: 'https://shop.test' });
    });

    it('denies without asking when the tab has no web origin, and when the gate errors', async () => {
      const blank = await confirmTab('about:blank');
      expect((await blank.ask()).result).toEqual({ allow: false });
      expect(requestConfirm).not.toHaveBeenCalled();

      const { client } = blank;
      const web = new FakeContents(42, 'https://shop.test/');
      web.debugger.handler = (method) => (method === 'Page.getFrameTree' ? TREE : {});
      registry.track(web);
      registry.claim(42, relay?.clients()[0] as RelayClient);
      const sessionId = await attach(client, 42);
      requestConfirm.mockRejectedValueOnce(new Error('renderer gone'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const reply = await client.send('AionRelay.requestConfirm', {
        webContentsId: 42,
        label: 'Send',
        sessionId,
        frameId: 'TOP',
      });
      expect(reply.result).toEqual({ allow: false });
      warn.mockRestore();
    });

    it('refuses malformed params, foreign sessions and tabs the client may not act on', async () => {
      const { client, ask, sessionId } = await confirmTab();
      const bad = [
        { sessionId: undefined },
        { frameId: undefined },
        { webContentsId: '40' },
        { label: 5 },
        { sessionId: 'nope' },
        { webContentsId: 41 },
      ];
      const replies = await Promise.all(bad.map((patch) => ask(patch)));
      expect(replies.map((reply) => reply.error !== undefined)).toEqual(bad.map(() => true));
      registry.track(new FakeContents(43, 'https://a.test/'));
      const other = await client.send('AionRelay.requestConfirm', {
        webContentsId: 43,
        label: 'Send',
        sessionId,
        frameId: 'TOP',
      });
      expect(other.error?.message).toMatch(/not shared/);
      expect(requestConfirm).not.toHaveBeenCalled();
    });

    it('denies the third pending confirm of a client', async () => {
      const { ask } = await confirmTab();
      const answers: Array<(allow: boolean) => void> = [];
      requestConfirm.mockImplementation(() => new Promise((resolve) => answers.push(resolve)));
      const first = ask();
      const second = ask({ label: 'Pay' });
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      expect((await ask({ label: 'Delete' })).result).toEqual({ allow: false });
      expect(requestConfirm).toHaveBeenCalledTimes(2);
      answers.forEach((answer) => answer(true));
      expect((await first).result).toEqual({ allow: true });
      expect((await second).result).toEqual({ allow: true });
      // The slots are free again.
      requestConfirm.mockResolvedValueOnce(true);
      expect((await ask()).result).toEqual({ allow: true });
    });

    it.each([
      ['the tab navigates', (c: FakeContents) => c.navigate('https://evil.test/')],
      ['the tab closes', (c: FakeContents) => c.destroy()],
    ])('aborts the pending confirm when %s', async (_name, trigger) => {
      const { ask, contents } = await confirmTab();
      let signal: AbortSignal | undefined;
      requestConfirm.mockImplementation(
        (_ask, s) =>
          new Promise((resolve) => {
            signal = s;
            s.addEventListener('abort', () => resolve(false));
          })
      );
      const reply = ask();
      await vi.waitFor(() => expect(signal).toBeDefined());
      expect(signal?.aborted).toBe(false);
      // A subframe or same-document navigation leaves the confirmed control where it is.
      contents.emit('did-start-navigation', { url: 'https://ads.test/', isMainFrame: false });
      contents.emit('did-start-navigation', { url: 'https://shop.test/#a', isMainFrame: true, isSameDocument: true });
      expect(signal?.aborted).toBe(false);
      trigger(contents);
      expect(signal?.aborted).toBe(true);
      expect((await reply).result).toEqual({ allow: false });
    });

    it('aborts the pending confirm when the client disconnects', async () => {
      const { client, ask } = await confirmTab();
      let signal: AbortSignal | undefined;
      requestConfirm.mockImplementation((_ask, s) => {
        signal = s;
        return new Promise(() => {});
      });
      void ask();
      await vi.waitFor(() => expect(signal).toBeDefined());
      client.ws.terminate();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    });
  });
});

describe('relay server: limits', () => {
  it('caps sessions per client', async () => {
    const handle = await start({ maxSessionsPerClient: 2 });
    const client = await connect(handle);
    ownedTab(30, 'claude');
    await attach(client, 30);
    await attach(client, 30);
    const third = await client.send('Target.attachToTarget', { targetId: 'wc-30', flatten: true });
    expect(third.error?.message).toMatch(/at most 2 sessions/);
  });

  it('runs at most 16 commands per socket at once and queues the rest', async () => {
    const handle = await start();
    const client = await connect(handle);
    const tab = ownedTab(31, 'claude');
    const session = await attach(client, 31);
    const releases: Array<() => void> = [];
    tab.debugger.handler = () => new Promise((resolve) => releases.push(() => resolve({})));

    const replies = Promise.all(Array.from({ length: 20 }, () => client.send('Page.getFrameTree', {}, session)));
    await vi.waitFor(() => expect(releases).toHaveLength(16));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(releases).toHaveLength(16);

    releases.splice(0, 16).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases.forEach((release) => release());
    expect((await replies).every((reply) => reply.error === undefined)).toBe(true);
  });

  it('closes a socket whose send buffer stays above the limit', async () => {
    const handle = await start({ maxBufferedBytes: 64 * 1024, bufferedGraceMs: 50 });
    const client = await connect(handle);
    const tab = ownedTab(32, 'claude');
    const session = await attach(client, 32);
    tab.debugger.handler = () => ({ data: 'x'.repeat(1024 * 1024) });

    client.ws.pause(); // stop reading, as a stuck client would
    for (let i = 0; i < 24; i += 1)
      client.ws.send(JSON.stringify({ id: 100 + i, method: 'Page.captureScreenshot', params: {}, sessionId: session }));

    // A paused client never sees the close itself; the relay dropping it is what counts.
    await vi.waitFor(() => expect(handle.clients()).toEqual([]), { timeout: 5000 });
  });

  it('caps live relay-created tabs per client', async () => {
    const handle = await start({ maxTabsPerClient: 2 });
    const client = await connect(handle);
    ownedTab(33, 'claude');
    ownedTab(34, 'claude');
    const reply = await client.send('Target.createTarget', { url: 'https://example.com' });
    expect(reply.error?.message).toMatch(/at most 2 tabs/);
    expect(openTab).not.toHaveBeenCalled();
  });

  it("lists a tab the agent's page opened as its own and counts it toward the tab cap", async () => {
    const handle = await start({ maxTabsPerClient: 2 });
    const client = await connect(handle);
    ownedTab(35, 'claude');
    registry.track(new FakeContents(36));
    registry.inherit(35, 36);

    const tabs = (await client.send('AionRelay.listTabs')).result?.tabs as Array<{ targetId: string; owner: string }>;
    expect(tabs.map(({ targetId, owner }) => ({ targetId, owner }))).toEqual([
      { targetId: 'wc-35', owner: 'agent' },
      { targetId: 'wc-36', owner: 'agent' },
    ]);
    const reply = await client.send('Target.createTarget', { url: 'https://example.com' });
    expect(reply.error?.message).toMatch(/at most 2 tabs/);
  });

  it('allows at most 5 createTarget calls per 10 s per client', async () => {
    const handle = await start();
    const client = await connect(handle);
    let id = 40;
    nextTab = () => {
      const tab = new FakeContents((id += 1));
      registry.track(tab);
      return Promise.resolve(tab);
    };
    const replies = await Promise.all(
      Array.from({ length: 6 }, () => client.send('Target.createTarget', { url: 'https://example.com' }))
    );
    expect(replies.slice(0, 5).every((reply) => reply.result?.targetId)).toBe(true);
    expect(replies[5].error?.message).toMatch(/rate limited/);
    expect(openTab).toHaveBeenCalledTimes(5);
  });
});

describe('relay server: queue', () => {
  it('refuses new commands once the queued bytes pass the cap, without closing the socket', async () => {
    const handle = await start({ maxInFlightPerSocket: 1, maxQueuedBytesPerSocket: 1000 });
    const client = await connect(handle);
    const tab = ownedTab(50, 'claude');
    const session = await attach(client, 50);
    const releases: Array<() => void> = [];
    tab.debugger.handler = () => new Promise((resolve) => releases.push(() => resolve({})));
    const padding = { expression: 'x'.repeat(500), contextId: 1 }; // denied by policy later; only its size matters here

    const running = client.send('Page.getFrameTree', {}, session);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const queued = client.send('Runtime.evaluate', padding, session);
    const refused = await client.send('Runtime.evaluate', padding, session);
    expect(refused.error?.message).toBe('Too many pending commands');

    releases[0]();
    await running;
    expect((await queued).error?.message).toMatch(/isolated-world/); // it ran, after waiting its turn
    tab.debugger.handler = () => ({});
    expect((await client.send('Page.getFrameTree', {}, session)).error).toBeUndefined();
  });

  it('answers Page.handleJavaScriptDialog even while every in-flight slot is taken', async () => {
    const handle = await start({ maxInFlightPerSocket: 2 });
    const client = await connect(handle);
    const tab = ownedTab(51, 'claude');
    const session = await attach(client, 51);
    const releases: Array<() => void> = [];
    tab.debugger.handler = (method) =>
      method === 'Page.handleJavaScriptDialog' ? {} : new Promise((resolve) => releases.push(() => resolve({})));

    const blocked = [client.send('Page.getFrameTree', {}, session), client.send('Page.getFrameTree', {}, session)];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const dialog = await client.send('Page.handleJavaScriptDialog', { accept: true }, session);

    expect(dialog.error).toBeUndefined();
    expect(releases).toHaveLength(2); // the stuck commands are still stuck
    releases.forEach((release) => release());
    await Promise.all(blocked);
  });
});

describe('relay server: dialog slots', () => {
  it('keeps concurrency within the cap plus 2 dialog slots under a dialog flood, and drains only into free slots', async () => {
    const handle = await start({ maxInFlightPerSocket: 2 });
    const client = await connect(handle);
    const tab = ownedTab(53, 'claude');
    const session = await attach(client, 53);
    let running = 0;
    let peak = 0;
    const releases: Array<{ method: string; release: () => void }> = [];
    tab.debugger.handler = (method) => {
      running += 1;
      peak = Math.max(peak, running);
      return new Promise((resolve) =>
        releases.push({
          method,
          release: () => {
            running -= 1;
            resolve({});
          },
        })
      );
    };
    const releaseAll = (method: string) =>
      releases.splice(0).forEach((entry) => (entry.method === method ? entry.release() : releases.push(entry)));

    const commands = Array.from({ length: 3 }, () => client.send('Page.getFrameTree', {}, session));
    await vi.waitFor(() => expect(releases).toHaveLength(2)); // the third command waits in the queue
    const dialogs = Array.from({ length: 5 }, () =>
      client.send('Page.handleJavaScriptDialog', { accept: true }, session)
    );
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    const settled = await Promise.all(dialogs.slice(2));
    expect(settled.every((reply) => reply.error?.message === 'Too many pending commands')).toBe(true);
    expect(peak).toBe(4); // cap 2 + 2 dialog slots

    // Finishing dialogs frees dialog slots only; the queued command still waits for a command slot.
    releaseAll('Page.handleJavaScriptDialog');
    await Promise.all(dialogs.slice(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(running).toBe(2);
    expect(releases.filter((entry) => entry.method === 'Page.getFrameTree')).toHaveLength(2);

    releaseAll('Page.getFrameTree');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releaseAll('Page.getFrameTree');
    expect((await Promise.all(commands)).every((reply) => reply.error === undefined)).toBe(true);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe('relay server: sockets', () => {
  it('logs, rather than crashes on, an upgrade socket the peer resets mid-handshake', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = await start();
    const { port } = new URL(handle.url);
    const upgradeErrors = () =>
      warn.mock.calls.filter(([message]) => message === '[AgentBrowserRelay] upgrade socket error:').length;
    // Send a handshake the relay refuses and reset the connection at once: its 403 then hits a dead
    // socket. Retried because the reset can occasionally lose the race with the reply.
    const resetOnce = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const raw = netConnect(Number(port), '127.0.0.1', () => {
          raw.write(
            `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
              `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: https://evil.example\r\n\r\n`,
            () => {
              raw.resetAndDestroy();
              resolve();
            }
          );
        });
        raw.on('error', () => {});
      });
    const resetUntilLogged = async (attemptsLeft: number): Promise<void> => {
      if (attemptsLeft === 0 || upgradeErrors() > 0) return;
      await resetOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await resetUntilLogged(attemptsLeft - 1);
    };
    await resetUntilLogged(20);
    expect(upgradeErrors()).toBeGreaterThan(0);
    // The relay is still up.
    expect((await (await connect(handle)).send('Target.getTargets')).error).toBeUndefined();
    warn.mockRestore();
  });

  it('survives a client socket error (an unmasked frame) and drops that client only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = await start();
    const good = await connect(handle, 'good');
    const { port } = new URL(handle.url);
    const raw = netConnect(Number(port), '127.0.0.1', () => {
      raw.write(
        `GET /?client=bad HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          `Authorization: Bearer ${handle.token}\r\n\r\n`
      );
    });
    raw.on('error', () => {});
    await new Promise((resolve) => raw.once('data', resolve)); // 101 Switching Protocols
    await vi.waitFor(() => expect(handle.clients().map((c) => c.label)).toContain('bad'));

    raw.write(Buffer.from([0x81, 0x01, 0x61])); // a text frame without the mask a client must set

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[AgentBrowserRelay] client socket error:', expect.any(String))
    );
    await vi.waitFor(() => expect(handle.clients().map((c) => c.label)).toEqual(['good']));
    expect((await good.send('Target.getTargets')).error).toBeUndefined();
    raw.destroy();
    warn.mockRestore();
  });
});

describe('relay server: OOPIF contexts', () => {
  it('drops a child session and its isolated worlds when the child detaches', async () => {
    const handle = await start();
    const client = await connect(handle);
    const tab = ownedTab(52, 'claude');
    await attach(client, 52);
    const announce = (cdpSessionId: string) =>
      tab.debugger.message('Target.attachedToTarget', {
        sessionId: cdpSessionId,
        targetInfo: { targetId: 'FRAME', type: 'iframe' },
      });
    tab.debugger.handler = (method) => (method === 'Page.createIsolatedWorld' ? { executionContextId: 9 } : {});

    announce('CDP-1');
    const first = String((await client.waitForEvent('Target.attachedToTarget')).params?.sessionId);
    await client.send('Page.createIsolatedWorld', { frameId: 'FRAME', worldName: 'aion' }, first);
    const evaluate = { expression: '1', contextId: 9 };
    expect((await client.send('Runtime.evaluate', evaluate, first)).error).toBeUndefined();

    tab.debugger.message('Target.detachedFromTarget', { sessionId: 'CDP-1', targetId: 'FRAME' });
    await client.waitForEvent('Target.detachedFromTarget');
    expect((await client.send('Runtime.evaluate', evaluate, first)).error?.message).toMatch(/unknown sessionId/i);

    // The same frame re-attached (e.g. after it navigated) starts with no worlds of its own.
    client.events.splice(0);
    announce('CDP-2');
    const second = String((await client.waitForEvent('Target.attachedToTarget')).params?.sessionId);
    expect((await client.send('Runtime.evaluate', evaluate, second)).error?.message).toMatch(/isolated-world/);
  });
});

describe('relay server: shared debugger sessions', () => {
  /** A non-relay client (the WebUI browser view) on the same tab debugger. */
  const viewer = async (sessions: DebuggerSessions, contents: FakeContents) => {
    const emit = vi.fn();
    const id = await sessions.attach(contents, { id: 'browser-view-1', emit });
    sessions.ready(id);
    return { id, emit };
  };

  it("an ownership change prunes only the relay's own clients' sessions", async () => {
    const sessions = createDebuggerSessions();
    const handle = await start({}, sessions);
    const client = await connect(handle);
    const tab = ownedTab(60, 'claude');
    await attach(client, 60);
    const view = await viewer(sessions, tab);

    registry.share(60, true);

    expect(sessions.session(view.id)).not.toBeNull();
    expect(view.emit).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'Target.detachedFromTarget' }));
  });

  it("agents never receive the viewer's screencast frames", async () => {
    const sessions = createDebuggerSessions();
    const handle = await start({}, sessions);
    const client = await connect(handle);
    const tab = ownedTab(61, 'claude');
    const session = await attach(client, 61);
    const view = await viewer(sessions, tab);

    tab.debugger.message('Page.screencastFrame', { data: '', metadata: {}, sessionId: 1 });
    tab.debugger.message('Page.loadEventFired', { timestamp: 1 });

    await client.waitForEvent('Page.loadEventFired', session);
    expect(client.events.map((e) => e.method)).not.toContain('Page.screencastFrame');
    expect(view.emit).toHaveBeenCalledWith(expect.objectContaining({ method: 'Page.screencastFrame' }));
  });
});

describe('relay server: runScript (write mode)', () => {
  const EVALUATED = { result: { type: 'string', value: 'from the page' } };
  const TOP_TREE = {
    frameTree: { frame: { id: 'TOP', url: 'https://shop.test/cart', securityOrigin: 'https://shop.test' } },
  };

  /** An agent-owned tab on shop.test with an attached session, and `run(…)` for the MCP's write-script request. */
  const scriptTab = async (id = 60) => {
    const client = await connect(await start());
    const contents = new FakeContents(id, 'https://shop.test/cart');
    contents.debugger.handler = (method) => {
      if (method === 'Runtime.evaluate') return EVALUATED;
      if (method === 'Page.getFrameTree') return TOP_TREE;
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 88 };
      return {};
    };
    registry.track(contents);
    registry.claim(id, relay?.clients()[0] as RelayClient);
    const sessionId = await attach(client, id);
    const run = (patch: Record<string, unknown> = {}) =>
      client.send('AionRelay.runScript', {
        webContentsId: id,
        sessionId,
        code: 'window.app.state',
        form: 'expression',
        world: 'page',
        ...patch,
      });
    const calls = (name: string) => contents.debugger.sendCommand.mock.calls.filter(([method]) => method === name);
    const evaluates = () => calls('Runtime.evaluate');
    return { client, contents, sessionId, run, calls, evaluates };
  };

  /** Holds the ask open until the test answers it. */
  const holdAsk = () => {
    const answer = { allow: (_allow: boolean) => {} };
    requestConfirm.mockImplementation(() => new Promise((resolve) => (answer.allow = resolve)));
    return answer;
  };

  it('asks with the origin from its own state and the whole code, and evaluates only after Allow', async () => {
    const { run, evaluates } = await scriptTab();
    const answer = holdAsk();
    const reply = run({ origin: 'https://evil.test', code: 'const s = window.app.state;\nreturn s;', form: 'body' });
    await vi.waitFor(() => expect(requestConfirm).toHaveBeenCalledTimes(1));
    expect(requestConfirm.mock.calls[0][0]).toEqual({
      origin: 'https://shop.test',
      frameOrigin: 'https://shop.test',
      label: '</> const s = window.app.state;\nreturn s;',
      codeLength: 37,
      clientLabel: 'claude',
      kind: 'script',
    });
    expect(evaluates()).toHaveLength(0);
    answer.allow(true);
    expect((await reply).result).toEqual({ allow: true, reply: EVALUATED });
    expect(evaluates()).toHaveLength(1);
    const [, params, cdpSession] = evaluates()[0];
    expect(params).toMatchObject({ awaitPromise: true, returnByValue: true, timeout: 10_000 });
    expect(params).not.toHaveProperty('contextId');
    expect(params).not.toHaveProperty('includeCommandLineAPI');
    expect(params).not.toHaveProperty('throwOnSideEffect');
    // The page is checked to still be the approved origin when the script starts.
    expect((params as { expression: string }).expression).toContain('location.origin !== "https://shop.test"');
    expect(cdpSession).toBeUndefined(); // the tab's own (top) session: the page's main world
  });

  it('world isolated asks the same way, then runs once in a fresh isolated world of the top frame', async () => {
    const { run, calls, evaluates } = await scriptTab();
    requestConfirm.mockResolvedValueOnce(true);
    expect((await run({ world: 'isolated' })).result).toEqual({ allow: true, reply: EVALUATED });
    expect(requestConfirm.mock.calls[0][0]).toMatchObject({ kind: 'script', origin: 'https://shop.test' });
    expect(calls('Page.createIsolatedWorld').map(([, params]) => params)).toEqual([
      { frameId: 'TOP', worldName: 'aion-browser-script' },
    ]);
    expect(evaluates()).toHaveLength(1);
    expect(evaluates()[0][1]).toMatchObject({ contextId: 88 });
    expect((evaluates()[0][1] as { expression: string }).expression).toContain(
      'location.origin !== "https://shop.test"'
    );
  });

  it.each([
    ['Deny', () => requestConfirm.mockResolvedValueOnce(false)],
    ['an error (e.g. a timed-out ask)', () => requestConfirm.mockRejectedValueOnce(new Error('timed out'))],
  ])('%s gives allow: false and sends no evaluate', async (_name, arrange) => {
    const { run, evaluates } = await scriptTab();
    arrange();
    expect((await run()).result).toEqual({ allow: false });
    expect(evaluates()).toHaveLength(0);
  });

  it('denies and sends nothing when the tab navigates during the ask', async () => {
    const { run, contents, evaluates } = await scriptTab();
    requestConfirm.mockImplementation(
      (_ask, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve(true)))
    );
    const reply = run();
    await vi.waitFor(() => expect(requestConfirm).toHaveBeenCalled());
    contents.navigate('https://evil.test/');
    expect((await reply).result).toEqual({ allow: false });
    expect(evaluates()).toHaveLength(0);
  });

  it('refuses after Allow when the page committed another origin without a navigation event', async () => {
    const { run, contents, evaluates } = await scriptTab();
    const answer = holdAsk();
    const reply = run();
    await vi.waitFor(() => expect(requestConfirm).toHaveBeenCalled());
    contents.commitSilently('https://evil.test/');
    answer.allow(true);
    expect((await reply).result).toEqual({ allow: false });
    expect(evaluates()).toHaveLength(0);
  });

  it('refuses after Allow when the user stopped sharing the tab during the ask', async () => {
    const client = await connect(await start());
    const shared = new FakeContents(63, 'https://bank.test/');
    registry.track(shared);
    registry.share(63, true);
    const sessionId = await attach(client, 63);
    const answer = holdAsk();
    const reply = client.send('AionRelay.runScript', {
      webContentsId: 63,
      sessionId,
      code: 'x',
      form: 'expression',
      world: 'page',
    });
    await vi.waitFor(() => expect(requestConfirm).toHaveBeenCalled());
    registry.share(63, false);
    answer.allow(true);
    expect((await reply).result).toEqual({ allow: false });
    expect(shared.debugger.sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false);
  });

  it('refuses after Allow when the session was detached during the ask', async () => {
    const { client, run, sessionId, evaluates } = await scriptTab();
    const answer = holdAsk();
    const reply = run();
    await vi.waitFor(() => expect(requestConfirm).toHaveBeenCalled());
    expect((await client.send('Target.detachFromTarget', { sessionId })).error).toBeUndefined();
    answer.allow(true);
    expect((await reply).result).toEqual({ allow: false });
    expect(evaluates()).toHaveLength(0);
  });

  it('spends the approval on one evaluate: a raw main-world evaluate is still denied, the next script asks again', async () => {
    const { client, sessionId, run, evaluates } = await scriptTab();
    requestConfirm.mockResolvedValue(true);
    expect((await run()).result).toMatchObject({ allow: true });
    const raw = await client.send(
      'Runtime.evaluate',
      { expression: 'document.cookie', returnByValue: true },
      sessionId
    );
    expect(raw.error?.message).toMatch(/isolated-world context/);
    expect((await run()).result).toMatchObject({ allow: true });
    expect(requestConfirm).toHaveBeenCalledTimes(2);
    expect(evaluates()).toHaveLength(2);
  });

  it('is bound to its tab and session: another tab, a foreign session or an OOPIF session is refused', async () => {
    const { client, run, contents, evaluates } = await scriptTab();
    requestConfirm.mockResolvedValue(true);
    const other = new FakeContents(61, 'https://other.test/');
    registry.track(other);
    registry.claim(61, relay?.clients()[0] as RelayClient);
    const otherSession = await attach(client, 61);
    expect((await run({ sessionId: otherSession })).error?.message).toMatch(/Unknown sessionId/);
    expect((await run({ webContentsId: 61 })).error?.message).toMatch(/Unknown sessionId/);
    expect((await run({ sessionId: 'nope' })).error?.message).toMatch(/Unknown sessionId/);
    // A cross-origin frame's child session reaches only that frame, never the tab's main world.
    contents.debugger.message('Target.attachedToTarget', {
      sessionId: 'OOPIF-1',
      targetInfo: { targetId: 'F1', type: 'iframe', url: 'https://ads.test/' },
      waitingForDebugger: false,
    });
    const child = await client.waitForEvent('Target.attachedToTarget');
    const childSession = String(child.params?.sessionId);
    expect((await run({ sessionId: childSession })).error?.message).toMatch(/tab session/);
    expect(requestConfirm).not.toHaveBeenCalled();
    expect(evaluates()).toHaveLength(0);
    expect(other.debugger.sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false);
  });

  it('refuses a user tab that is not shared, and malformed params, without asking', async () => {
    const { client, run } = await scriptTab();
    registry.track(new FakeContents(62, 'https://bank.test/'));
    const refused = await client.send('AionRelay.runScript', {
      webContentsId: 62,
      sessionId: 'x',
      code: 'document.cookie',
      form: 'expression',
      world: 'page',
    });
    expect(refused.error?.message).toMatch(/not shared/);
    for (const patch of [
      { code: '' },
      { code: 5 },
      { form: 'module' },
      { world: 'devtools' },
      { world: undefined },
      { code: 'x'.repeat(50_001) },
    ]) {
      expect((await run(patch)).error?.message, JSON.stringify(patch).slice(0, 40)).toMatch(/Invalid/);
    }
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it.each(['page', 'isolated'])(
    'logs only the origin and the world (%s), never the code or the result',
    async (world) => {
      const spies = (['info', 'warn', 'error', 'log'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation(() => undefined)
      );
      const { run } = await scriptTab();
      requestConfirm.mockResolvedValueOnce(true);
      await run({ code: 'secretCode()', world });
      const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
      expect(logged).toContain('https://shop.test');
      expect(logged).toContain(`world: ${world}`);
      expect(logged).not.toContain('secretCode');
      expect(logged).not.toContain('from the page');
    }
  );
});

describe("relay server: a VA Bot's new chat takes over its tabs", () => {
  const BOT: BrowserTabProfile = { kind: 'agent', agentId: 'bot-b' };
  const OTHER_BOT: BrowserTabProfile = { kind: 'agent', agentId: 'bot-o' };
  const botOf: Record<string, BrowserTabProfile> = {
    conv_C1: BOT,
    conv_C2: BOT,
    conv_O: OTHER_BOT,
    conv_S: BOT,
  };
  /** When each chat was created, and whether it runs scheduled turns. */
  const chatOf: Record<string, { createdAt: number; scheduled: boolean }> = {
    conv_C1: { createdAt: 1, scheduled: false },
    conv_C2: { createdAt: 2, scheduled: false },
    conv_O: { createdAt: 1, scheduled: false },
    conv_S: { createdAt: 3, scheduled: true },
  };

  /** A tab in `profile` that the connected client `label` opened. */
  const botTab = (id: number, profile: BrowserTabProfile, label: string, conversationId: string): void => {
    registry.track(new FakeContents(id), profile);
    const client = relay?.clients().find((c) => c.label === label);
    if (!client) throw new Error(`no client ${label}`);
    registry.claim(id, { ...client, conversationId });
  };

  it("re-claims the bot's disconnected and other-chat tabs for the new chat; the old chat can no longer act", async () => {
    resolveProfile.mockImplementation(async (conversationId?: string) => ({
      profile: (conversationId && botOf[conversationId]) || agentProfileOf(conversationId),
      final: true,
    }));
    const onAgentTab = vi.fn();
    registry = createTargetRegistry();
    relay = await startRelayServer({
      registry,
      openTab,
      closeTab,
      onAgentAction,
      requestConfirm,
      waitForTab,
      resolveProfile,
      onAgentTab,
      chatInfo: async (id: string) => chatOf[id] ?? null,
      limits: { maxTabsPerClient: 2 },
    });
    const first = await connect(relay, 'c1', { 'X-Aion-Conversation': 'conv_C1' });
    const gone = await connect(relay, 'gone', { 'X-Aion-Conversation': 'conv_C1' });
    const other = await connect(relay, 'o', { 'X-Aion-Conversation': 'conv_O' });
    await Promise.all([first, gone, other].map((c) => c.send('AionRelay.listTabs')));
    botTab(100, BOT, 'c1', 'conv_C1');
    botTab(101, BOT, 'gone', 'conv_C1');
    registry.track(new FakeContents(102), BOT); // the user's own tab in the bot's profile
    botTab(103, OTHER_BOT, 'o', 'conv_O');
    gone.ws.close();
    await vi.waitFor(() => expect(registry.ownership(101)?.owner).toMatchObject({ label: 'agent (disconnected)' }));
    const session = await attach(first, 100);
    const later = Date.now() + 60_000;
    vi.spyOn(Date, 'now').mockReturnValueOnce(later);
    registry.touch(101); // the most recently used of the two
    const onChange = vi.fn();
    registry.onChange(onChange);

    const next = await connect(relay, 'c2', { 'X-Aion-Conversation': 'conv_C2' });
    const listed = (await next.send('AionRelay.listTabs')).result?.tabs as Array<{ targetId: string; owner: string }>;

    expect(listed.map(({ targetId, owner }) => ({ targetId, owner }))).toEqual([
      { targetId: 'wc-100', owner: 'agent' },
      { targetId: 'wc-101', owner: 'agent' },
    ]);
    const newClient = relay.clients().find((c) => c.label === 'c2');
    for (const id of [100, 101]) {
      expect(registry.ownership(id)?.owner).toEqual({
        clientId: newClient?.clientId,
        label: 'c2',
        conversationId: 'conv_C2',
      });
    }
    expect(registry.ownership(102)?.owner).toBe('user');
    expect(registry.ownership(103)?.owner).toMatchObject({ label: 'o', conversationId: 'conv_O' });
    expect(onChange).toHaveBeenCalled();
    // The old chat's session on the tab ends, and it cannot act on or re-attach to it.
    expect((await first.waitForEvent('Target.detachedFromTarget')).params).toMatchObject({ sessionId: session });
    expect((await first.send('Page.getFrameTree', {}, session)).error).toBeDefined();
    expect((await first.send('Target.attachToTarget', { targetId: 'wc-100', flatten: true })).error?.message).toMatch(
      /not shared/i
    );
    expect((await first.send('AionRelay.listTabs')).result?.tabs).toEqual([]);
    // At the cap the connection stands; the re-claimed tabs count, and hygiene sees the newest first.
    expect((await next.send('Target.createTarget', { url: 'https://example.com' })).error?.message).toMatch(
      /at most 2 tabs/
    );
    expect(onAgentTab.mock.calls.map(([id]) => id)).toEqual([101, 100]);
  });

  /** A relay where every chat above runs as its bot, plus one connected client per chat given. */
  const startBots = async (chatInfo?: (id: string) => Promise<{ createdAt: number; scheduled: boolean } | null>) => {
    resolveProfile.mockImplementation(async (conversationId?: string) => ({
      profile: (conversationId && botOf[conversationId]) || agentProfileOf(conversationId),
      final: true,
    }));
    registry = createTargetRegistry();
    relay = await startRelayServer({
      registry,
      openTab,
      closeTab,
      onAgentAction,
      requestConfirm,
      waitForTab,
      resolveProfile,
      chatInfo: chatInfo ?? (async (id: string) => chatOf[id] ?? null),
    });
    return relay;
  };

  it("never takes a live newer chat's tabs for an older chat, only a gone client's (M3)", async () => {
    const handle = await startBots();
    const newer = await connect(handle, 'c2', { 'X-Aion-Conversation': 'conv_C2' });
    const gone = await connect(handle, 'gone', { 'X-Aion-Conversation': 'conv_C2' });
    await Promise.all([newer, gone].map((c) => c.send('AionRelay.listTabs')));
    botTab(120, BOT, 'c2', 'conv_C2');
    botTab(121, BOT, 'gone', 'conv_C2');
    gone.ws.close();
    await vi.waitFor(() => expect(registry.ownership(121)?.owner).toMatchObject({ label: 'agent (disconnected)' }));

    const older = await connect(handle, 'c1', { 'X-Aion-Conversation': 'conv_C1' });
    const listed = (await older.send('AionRelay.listTabs')).result?.tabs as Array<{ targetId: string }>;

    expect(listed.map(({ targetId }) => targetId)).toEqual(['wc-121']);
    expect(registry.ownership(120)?.owner).toMatchObject({ label: 'c2', conversationId: 'conv_C2' });
    expect((await newer.send('AionRelay.listTabs')).result?.tabs).toHaveLength(1);
  });

  it("takes nothing for a scheduled chat, even a gone client's tab", async () => {
    const handle = await startBots();
    const owner = await connect(handle, 'c2', { 'X-Aion-Conversation': 'conv_C2' });
    await owner.send('AionRelay.listTabs');
    botTab(130, BOT, 'c2', 'conv_C2');
    registry.track(new FakeContents(131), BOT);
    registry.claim(131, { clientId: 'disconnected:x', label: 'agent (disconnected)', conversationId: 'conv_C1' });

    const scheduled = await connect(handle, 's', { 'X-Aion-Conversation': 'conv_S' });

    expect((await scheduled.send('AionRelay.listTabs')).result?.tabs).toEqual([]);
    expect(registry.ownership(130)?.owner).toMatchObject({ label: 'c2' });
    expect(registry.ownership(131)?.owner).toMatchObject({ clientId: 'disconnected:x' });
  });

  it("takes a live owner's tabs only when both chats' ages are known", async () => {
    const handle = await startBots(async (id) => (id === 'conv_C2' ? chatOf[id] : null));
    const owner = await connect(handle, 'c1', { 'X-Aion-Conversation': 'conv_C1' });
    await owner.send('AionRelay.listTabs');
    botTab(140, BOT, 'c1', 'conv_C1');

    const next = await connect(handle, 'c2', { 'X-Aion-Conversation': 'conv_C2' });

    expect((await next.send('AionRelay.listTabs')).result?.tabs).toEqual([]);
    expect(registry.ownership(140)?.owner).toMatchObject({ label: 'c1' });
  });

  it('takes nothing for a regular chat or a client with no chat', async () => {
    const handle = await start();
    registry.track(new FakeContents(110), agentProfileOf());
    registry.claim(110, { clientId: 'old', label: 'old' });
    registry.releaseClient('old');
    resolveProfile.mockResolvedValueOnce({ profile: { kind: 'temporary', conversationId: 'conv_T' }, final: true });
    const regular = await connect(handle, 'r', { 'X-Aion-Conversation': 'conv_T' });
    const noChat = await connect(handle, 'n');

    expect((await regular.send('AionRelay.listTabs')).result?.tabs).toEqual([]);
    expect((await noChat.send('AionRelay.listTabs')).result?.tabs).toEqual([]);
    expect(registry.ownership(110)?.owner).toMatchObject({ clientId: 'disconnected:old' });
  });
});
