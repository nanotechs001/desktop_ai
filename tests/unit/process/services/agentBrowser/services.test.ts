import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { TabOwnership } from '@/common/types/browser';
import { FakeContents } from './relay/fakes';

type Provider = (args: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; msg?: string }>;

const h = vi.hoisted(() => {
  const providers = new Map<string, Provider>();
  const provider = (name: string) => ({ provider: (fn: Provider) => providers.set(name, fn) });
  const emitter = () => ({ emit: vi.fn() });
  return {
    providers,
    created: [] as Array<(contents: unknown) => void>,
    ipcBridge: {
      agentBrowser: {
        ownershipChanged: emitter(),
        agentAction: emitter(),
        share: provider('share'),
        resume: provider('resume'),
        getOwnership: provider('getOwnership'),
        confirmRequested: emitter(),
        getConfirmRequests: provider('getConfirmRequests'),
        replyConfirm: provider('replyConfirm'),
        refuseTab: provider('refuseTab'),
        ensureAgentRule: provider('ensureAgentRule'),
        ensureDefaultAgent: provider('ensureDefaultAgent'),
        defaultAgentReady: emitter(),
      },
      browser: { openTabRequested: emitter(), closeTabRequested: emitter() },
    },
  };
});

vi.mock('@/common', () => ({ ipcBridge: h.ipcBridge }));
const backend = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/common/adapter/httpBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/adapter/httpBridge')>()),
  httpRequest: backend.request,
}));
// The "Always allow" file lives under the home directory; keep a test run away from the user's own.
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  const { mkdtempSync } = await import('node:fs');
  const home = mkdtempSync(os.tmpdir() + '/services-test-home-');
  return { ...os, homedir: () => home, default: { ...os, homedir: () => home } };
});
vi.mock('@process/services/browserSession/browserSession', () => ({
  onBrowserContentsCreated: (listener: (contents: unknown) => void) => {
    h.created.push(listener);
    return () => {};
  },
}));

const { startAgentBrowserServices } = await import('@process/services/agentBrowser/services');
const { agentPartition, rememberBrowserSession } =
  await import('@process/services/browserSession/profiles/browserProfiles');

/** Browser sessions as browserSession sets them up: Personal, the shared default Agent profile, and one Agent's. */
const personalSession = { name: 'personal' } as unknown as Electron.Session;
const defaultAgentSession = { name: 'default agent' } as unknown as Electron.Session;
const agentSession = { name: 'agent' } as unknown as Electron.Session;
rememberBrowserSession('persist:aionui-browser', personalSession);
rememberBrowserSession(agentPartition('aion-default-agent'), defaultAgentSession);
rememberBrowserSession(agentPartition('bare:agent-1'), agentSession);
const DEFAULT_AGENT_PROFILE = { kind: 'agent', agentId: 'aion-default-agent' } as const;
/** conv-1 belongs to Agent bare:agent-1; any other chat has no Agent (another engine, a built-in). */
const resolveAgent = vi.fn(async (conversationId: string) =>
  conversationId === 'conv-1'
    ? ({ ok: true, agentId: 'bare:agent-1' } as const)
    : ({ ok: false, message: 'No Agent for this chat' } as const)
);

type Services = NonNullable<Awaited<ReturnType<typeof startAgentBrowserServices>>>;
type Reply = { id: number; result?: Record<string, unknown>; error?: { message: string } };

let services: Services | null = null;
const sockets: WebSocket[] = [];

const start = async (): Promise<Services> => {
  const started = await startAgentBrowserServices({ enabled: true, blockedPorts: () => [], resolveAgent });
  if (!started) throw new Error('relay did not start');
  services = started;
  return started;
};

/** A new browser tab in `session` (the default Agent profile unless given), as browserSession dispatches it. */
const newTab = (id: number, session: Electron.Session = defaultAgentSession): FakeContents => {
  const tab = Object.assign(new FakeContents(id), { session });
  h.created.forEach((listener) => listener(tab));
  return tab;
};

const call = (name: string, args: Record<string, unknown> = {}) => {
  const provider = h.providers.get(name);
  if (!provider) throw new Error(`no provider ${name}`);
  return provider(args);
};

const ownership = async (id: number): Promise<TabOwnership | undefined> =>
  ((await call('getOwnership')).data as TabOwnership[]).find((t) => t.webContentsId === id);

const connect = async (relay: Services, label: string, headers: Record<string, string> = {}) => {
  const url = new URL(relay.url);
  url.searchParams.set('client', label);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${relay.token}`, ...headers } });
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 1;
  const waiting = new Map<number, (reply: Reply) => void>();
  ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Reply;
    waiting.get(message.id)?.(message);
  });
  return (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Reply> =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
};

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await services?.close();
  services = null;
  h.created.splice(0);
  vi.clearAllMocks();
});

describe('agent browser services: IPC', () => {
  it('answers the IPC with an error while agent control is off', async () => {
    expect(await startAgentBrowserServices({ enabled: false, blockedPorts: () => [] })).toBeNull();
    expect(h.created).toHaveLength(0);
    expect((await call('getOwnership')).success).toBe(false);
    expect((await call('share', { webContentsId: 1, on: true })).success).toBe(false);
    expect((await call('resume', { webContentsId: 1 })).success).toBe(false);
  });

  it('validates arguments and unknown tabs', async () => {
    await start();
    newTab(5);
    expect(await call('share', { webContentsId: '5', on: true })).toMatchObject({
      success: false,
      msg: 'Invalid arguments',
    });
    expect(await call('share', { webContentsId: 5, on: 'yes' })).toMatchObject({
      success: false,
      msg: 'Invalid arguments',
    });
    expect(await call('resume', { webContentsId: 5.5 })).toMatchObject({ success: false, msg: 'Invalid arguments' });
    expect(await call('share', { webContentsId: 6, on: true })).toMatchObject({
      success: false,
      msg: 'No such browser tab',
    });
    expect(await call('share', { webContentsId: 5, on: true })).toEqual({ success: true });
    expect((await ownership(5))?.sharedWith).toBe('all');
  });
});

describe('agent browser services: tabs', () => {
  it('tracks a new tab before the createTarget waiter hands it out, then claims it', async () => {
    const relay = await start();
    const send = await connect(relay, 'claude');
    const created = send('Target.createTarget', { url: 'https://a.test/' });
    await vi.waitFor(() =>
      expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalledWith({
        url: 'https://a.test/',
        background: false,
        profile: DEFAULT_AGENT_PROFILE,
      })
    );

    const tab = newTab(7);
    const emits = h.ipcBridge.agentBrowser.ownershipChanged.emit.mock.calls;
    expect(emits.at(-1)?.[0]).toEqual([{ webContentsId: 7, owner: 'user', sharedWith: null, paused: false }]);
    tab.navigate('https://a.test/');

    expect((await created).result).toEqual({ targetId: 'wc-7' });
    const latest = (emits.at(-1)?.[0] ?? []) as TabOwnership[];
    expect(latest[0]?.owner).toMatchObject({ label: 'claude' });
  });

  it("asks the pane for the tab in the agent's chat; a tab-cap refusal fails createTarget at once with the specific error", async () => {
    const relay = await start();
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-1' });
    const created = send('Target.createTarget', { url: 'https://a.test/' });
    await vi.waitFor(() =>
      expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalledWith({
        url: 'https://a.test/',
        background: false,
        conversationId: 'conv-1',
        profile: { kind: 'agent', agentId: 'bare:agent-1' },
      })
    );

    expect(await call('refuseTab', { url: 'https://a.test/', max: 10, conversationId: 'conv-1' })).toEqual({
      success: true,
    });

    expect((await created).error?.message).toBe(
      'The browser has too many tabs open (max 10). Close some tabs and try again.'
    );
  });

  it('refuses only the request of the chat the pane refused, when two chats ask for the same url', async () => {
    const relay = await start();
    const sendA = await connect(relay, 'a', { 'X-Aion-Conversation': 'conv-a' });
    const sendB = await connect(relay, 'b', { 'X-Aion-Conversation': 'conv-b' });
    const createdA = sendA('Target.createTarget', { url: 'https://same.test/' });
    const createdB = sendB('Target.createTarget', { url: 'https://same.test/' });
    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalledTimes(2));

    await call('refuseTab', { url: 'https://same.test/', max: 10, conversationId: 'conv-b' });
    expect((await createdB).error?.message).toMatch(/too many tabs/);

    const tab = newTab(9);
    tab.navigate('https://same.test/');
    expect((await createdA).result).toEqual({ targetId: 'wc-9' });
  });

  it("opens an agent's tab in its chat's Agent profile and never claims a same-url tab from another profile", async () => {
    const relay = await start();
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-1' });
    const created = send('Target.createTarget', { url: 'https://a.test/' });
    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalled());
    expect(resolveAgent).toHaveBeenCalledWith('conv-1');

    const userTab = newTab(11, personalSession);
    const otherAgentTab = newTab(12, defaultAgentSession);
    const agentTab = newTab(13, agentSession);
    userTab.navigate('https://a.test/');
    otherAgentTab.navigate('https://a.test/');
    agentTab.navigate('https://a.test/');

    expect((await created).result).toEqual({ targetId: 'wc-13' });
    expect((await ownership(11))?.owner).toBe('user');
    expect((await ownership(12))?.owner).toBe('user');
  });

  it('uses the shared default Agent profile, never Personal, when the chat has no Agent or there is no chat', async () => {
    const relay = await start();
    const other = await connect(relay, 'a', { 'X-Aion-Conversation': 'conv-2' });
    const none = await connect(relay, 'b');
    void other('Target.createTarget', { url: 'https://a.test/' });
    void none('Target.createTarget', { url: 'https://b.test/' });

    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalledTimes(2));
    const profiles = h.ipcBridge.browser.openTabRequested.emit.mock.calls.map(([event]) => event.profile);
    expect(profiles).toEqual([DEFAULT_AGENT_PROFILE, DEFAULT_AGENT_PROFILE]);
  });

  it('validates a tab refusal and ignores one nobody is waiting for', async () => {
    await start();
    expect(await call('refuseTab', { url: 5, max: 10 })).toMatchObject({ success: false, msg: 'Invalid arguments' });
    expect(await call('refuseTab', { url: 'https://a.test/', max: 0 })).toMatchObject({ success: false });
    expect(await call('refuseTab', { url: 'https://a.test/', max: 10, conversationId: 'a/b' })).toMatchObject({
      success: false,
    });
    expect(await call('refuseTab', { url: 'https://nobody.test/', max: 10 })).toEqual({ success: true });
  });

  it('never claims a user tab opened during the wait, and pairs two agents by url', async () => {
    const relay = await start();
    const sendA = await connect(relay, 'a');
    const sendB = await connect(relay, 'b');
    const createdA = sendA('Target.createTarget', { url: 'https://a.test/' });
    const createdB = sendB('Target.createTarget', { url: 'https://b.test/' });
    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalledTimes(2));

    const userTab = newTab(1);
    const tabB = newTab(2);
    const tabA = newTab(3);
    userTab.navigate('https://user.test/');
    tabB.navigate('https://b.test/');
    tabA.navigate('https://a.test/');

    expect((await createdA).result).toEqual({ targetId: 'wc-3' });
    expect((await createdB).result).toEqual({ targetId: 'wc-2' });
    expect((await ownership(1))?.owner).toBe('user');
    expect((await ownership(2))?.owner).toMatchObject({ label: 'b' });
  });
});

describe('agent browser services: confirm gate', () => {
  const confirmed = () => h.ipcBridge.agentBrowser.confirmRequested.emit.mock.calls;

  it('publishes a risky ask with the tab origin, and the pane reply decides it', async () => {
    const relay = await start();
    const send = await connect(relay, 'claude');
    const tab = newTab(21);
    tab.debugger.handler = (method) =>
      method === 'Page.getFrameTree'
        ? { frameTree: { frame: { id: 'TOP', url: 'https://example.com/', securityOrigin: 'https://example.com' } } }
        : {};
    await call('share', { webContentsId: 21, on: true });
    const sessionId = String(
      (await send('Target.attachToTarget', { targetId: 'wc-21', flatten: true })).result?.sessionId
    );

    const answer = send('AionRelay.requestConfirm', {
      webContentsId: 21,
      label: 'Delete account',
      sessionId,
      frameId: 'TOP',
    });
    await vi.waitFor(() => expect(confirmed().length).toBeGreaterThan(0));
    const [open] = (await call('getConfirmRequests')).data as Array<{ id: string }>;
    expect(confirmed().at(-1)?.[0]).toEqual([
      {
        id: open.id,
        origin: 'https://example.com',
        frameOrigin: 'https://example.com',
        label: 'Delete account',
        clientLabel: 'claude',
      },
    ]);

    expect(await call('replyConfirm', { id: open.id, allow: true, alwaysForSite: false })).toEqual({ success: true });
    expect((await answer).result).toEqual({ allow: true });
    expect(confirmed().at(-1)?.[0]).toEqual([]);
    expect(await call('replyConfirm', { id: open.id, allow: true, alwaysForSite: false })).toMatchObject({
      success: false,
    });
  });

  it('validates the reply arguments', async () => {
    await start();
    for (const args of [
      { id: 1, allow: true, alwaysForSite: false },
      { id: 'a', allow: 'y', alwaysForSite: false },
      { id: 'a', allow: true },
    ]) {
      expect(await call('replyConfirm', args)).toMatchObject({ success: false, msg: 'Invalid arguments' });
    }
  });
});

describe('agent browser services: take-over', () => {
  it('pauses a shared tab on a user keyDown (not a modifier alone) or mouseDown; resume clears it', async () => {
    await start();
    const tab = newTab(9);
    await call('share', { webContentsId: 9, on: true });

    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'Shift' });
    tab.emit('before-input-event', {}, { type: 'keyUp', key: 'a' });
    expect((await ownership(9))?.paused).toBe(false);
    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
    expect((await ownership(9))?.paused).toBe(true);

    expect(await call('resume', { webContentsId: 9 })).toEqual({ success: true });
    expect((await ownership(9))?.paused).toBe(false);
    tab.emit('before-mouse-event', {}, { type: 'mouseMove', x: 1, y: 1 });
    expect((await ownership(9))?.paused).toBe(false);
    tab.emit('before-mouse-event', {}, { type: 'mouseDown', x: 1, y: 1 });
    expect((await ownership(9))?.paused).toBe(true);
  });

  it("does not pause on the mouseDown Electron reports for the agent's own click, in zoomed coordinates", async () => {
    const relay = await start();
    const send = await connect(relay, 'claude');
    const tab = newTab(11);
    tab.zoom = 2;
    await call('share', { webContentsId: 11, on: true });
    const session = String(
      (await send('Target.attachToTarget', { targetId: 'wc-11', flatten: true })).result?.sessionId
    );
    tab.debugger.handler = (method) => {
      if (method === 'Input.dispatchMouseEvent')
        tab.emit('before-mouse-event', {}, { type: 'mouseDown', x: 20, y: 40 });
      return {};
    };

    await send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 },
      session
    );

    expect((await ownership(11))?.paused).toBe(false);
  });
});

describe('Agent IPC', () => {
  afterEach(() => {
    backend.request.mockReset();
    h.ipcBridge.agentBrowser.defaultAgentReady.emit.mockClear();
  });

  it('ensureAgentRule validates its arguments before touching any rule', async () => {
    await start();
    const invalid = { success: false, msg: 'Invalid arguments' };
    expect(await call('ensureAgentRule', {})).toEqual(invalid);
    expect(await call('ensureAgentRule', { assistantId: 'x'.repeat(129) })).toEqual(invalid);
    expect(await call('ensureAgentRule', { assistantId: 'a', locale: '../x' })).toEqual(invalid);
    expect(backend.request).not.toHaveBeenCalled();
  });

  it('ensureAgentRule adds the block to the default and the given locale rule, and answers even with agent control off', async () => {
    const writes: Array<Record<string, unknown>> = [];
    backend.request.mockImplementation(async (_method: string, path: string, body: Record<string, unknown>) => {
      if (path.endsWith('/write')) writes.push(body);
      return '';
    });
    // not started: the provider is registered for the renderer either way
    await startAgentBrowserServices({ enabled: false, blockedPorts: () => [] });

    expect(await call('ensureAgentRule', { assistantId: 'new-agent', locale: 'zh-CN' })).toEqual({ success: true });

    expect(writes.map((w) => w.locale)).toEqual([undefined, 'zh-CN']);
    expect(writes.every((w) => w.assistant_id === 'new-agent' && String(w.content).includes('aion-browser-rule'))).toBe(
      true
    );
  });

  it('ensureDefaultAgent creates the Agent and announces it, or stays quiet with no engine', async () => {
    backend.request.mockImplementation(async (method: string, path: string) => {
      if (path.startsWith('/api/settings/client') && method === 'GET') return {};
      if (path === '/api/assistants' && method === 'GET') return [];
      if (path === '/api/agents/management')
        return [{ id: 'claude', enabled: true, status: 'online', agent_type: 'acp' }];
      return '';
    });
    await startAgentBrowserServices({ enabled: false, blockedPorts: () => [] });

    expect(await call('ensureDefaultAgent')).toEqual({ success: true });
    expect(h.ipcBridge.agentBrowser.defaultAgentReady.emit).toHaveBeenCalledWith({ id: 'aion-default-agent' });

    h.ipcBridge.agentBrowser.defaultAgentReady.emit.mockClear();
    backend.request.mockImplementation(async (method: string, path: string) =>
      path === '/api/agents/management' ? [] : path === '/api/assistants' && method === 'GET' ? [] : {}
    );
    expect(await call('ensureDefaultAgent')).toEqual({ success: true });
    expect(h.ipcBridge.agentBrowser.defaultAgentReady.emit).not.toHaveBeenCalled();
  });
});
