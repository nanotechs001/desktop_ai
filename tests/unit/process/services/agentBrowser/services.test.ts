import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
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
        userInput: emitter(),
        share: provider('share'),
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
      conversation: { runtimeMode: { invoke: vi.fn() }, get: { invoke: vi.fn() } },
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
type WindowOpenHooks = import('@process/services/browserSession/windowOpen').WindowOpenHooks;
const hooks = vi.hoisted(() => ({ current: {} as WindowOpenHooks }));
vi.mock('@process/services/browserSession/windowOpen', () => ({
  setWindowOpenHooks: (next: WindowOpenHooks) => {
    hooks.current = next;
  },
}));
vi.mock('@process/services/browserSession/browserSession', () => ({
  onBrowserContentsCreated: (listener: (contents: unknown) => void) => {
    h.created.push(listener);
    return () => {};
  },
  shownBrowserTab: () => null,
}));

const {
  agentTabProfile,
  chatInfoOf,
  getBrowserViewService,
  liveAgentProfile,
  startAgentBrowserServices,
  webuiConfirms,
} = await import('@process/services/agentBrowser/services');
const { agentPartition, deleteAgentBrowserData, rememberBrowserSession, temporaryPartition } =
  await import('@process/services/browserSession/profiles/browserProfiles');

/** Browser sessions as browserSession sets them up: Personal, the shared default Agent profile, and one Agent's. */
const personalSession = { name: 'personal' } as unknown as Electron.Session;
const defaultAgentSession = { name: 'default agent' } as unknown as Electron.Session;
const agentSession = { name: 'agent' } as unknown as Electron.Session;
rememberBrowserSession('persist:aionui-browser', personalSession);
rememberBrowserSession(agentPartition('aion-default-agent'), defaultAgentSession);
rememberBrowserSession(agentPartition('bare:agent-1'), agentSession);
const DEFAULT_AGENT_PROFILE = { kind: 'agent', agentId: 'aion-default-agent' } as const;
/** Regular chats (no user-created Agent) each browse in their own temporary in-memory session. */
const temporaryProfile = (conversationId: string) => ({ kind: 'temporary', conversationId }) as const;
const temporarySessionA = { name: 'temporary a' } as unknown as Electron.Session;
rememberBrowserSession(temporaryPartition('conv-a'), temporarySessionA);
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

const start = async (extra: Partial<Parameters<typeof startAgentBrowserServices>[0]> = {}): Promise<Services> => {
  const started = await startAgentBrowserServices({ enabled: true, blockedPorts: () => [], resolveAgent, ...extra });
  if (!started) throw new Error('relay did not start');
  services = started;
  return started;
};

/** A new browser tab in `session` (the default Agent profile unless given), as browserSession dispatches it. */
const newTab = (id: number, session: Electron.Session = defaultAgentSession, url?: string): FakeContents => {
  const tab = Object.assign(new FakeContents(id, url), { session });
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
    expect(await call('share', { webContentsId: 6, on: true })).toMatchObject({
      success: false,
      msg: 'No such browser tab',
    });
    expect(await call('share', { webContentsId: 5, on: true })).toEqual({ success: true });
    expect((await ownership(5))?.sharedWith).toBe('all');
  });
});

describe('chatInfoOf', () => {
  it("reads a chat's creation time, and whether it is a scheduled run's own chat", async () => {
    const get = h.ipcBridge.conversation.get.invoke;
    get.mockResolvedValueOnce({ id: 'c1', created_at: 5, extra: {} });
    expect(await chatInfoOf('c1')).toEqual({ createdAt: 5, scheduled: false });
    get.mockResolvedValueOnce({ id: 'c2', created_at: 6, extra: { cron_job_id: 'cron_1', scheduled_run: true } });
    expect(await chatInfoOf('c2')).toEqual({ createdAt: 6, scheduled: true });
    // The user's own chat a task is bound to is not a scheduled run's chat.
    get.mockResolvedValueOnce({ id: 'c3', created_at: 7, extra: { cron_job_id: 'cron_2' } });
    expect(await chatInfoOf('c3')).toEqual({ createdAt: 7, scheduled: false });
    get.mockResolvedValueOnce(null);
    expect(await chatInfoOf('gone')).toBeNull();
  });
});

describe('agentTabProfile', () => {
  it("uses the chat's Agent, and the default Agent profile once that Agent's browser data is deleted", async () => {
    expect(await agentTabProfile(resolveAgent, 'conv-1')).toEqual({
      profile: { kind: 'agent', agentId: 'bare:agent-1' },
      final: true,
    });
    const deleted = vi.fn(async () => ({ ok: true, agentId: 'bare:deleted' }) as const);
    const folder = `/u/Partitions/${agentPartition('bare:deleted').slice('persist:'.length)}`;
    const session = { storagePath: folder, clearStorageData: vi.fn(), clearCache: vi.fn(), clearAuthCache: vi.fn() };
    await deleteAgentBrowserData('bare:deleted', {
      userDataDir: '/u',
      fromPartition: () => session,
      closeLiveContents: async () => {},
      unloadExtensions: () => {},
      removeDir: async () => {},
      forgetPartition: () => {},
    });

    expect(await agentTabProfile(deleted, 'conv-9')).toEqual({ profile: DEFAULT_AGENT_PROFILE, final: true });
    // A client that connected before the deletion opens its next tab in the default Agent profile too.
    expect(liveAgentProfile({ kind: 'agent', agentId: 'bare:deleted' })).toEqual(DEFAULT_AGENT_PROFILE);
    expect(liveAgentProfile({ kind: 'agent', agentId: 'bare:agent-1' })).toEqual({
      kind: 'agent',
      agentId: 'bare:agent-1',
    });
  });
});

describe('agentTabProfile lookups', () => {
  it('marks a default fallback caused by a lookup error as not final, so the relay retries it', async () => {
    const failing = vi.fn(async () => ({ ok: false, message: "Couldn't look up", transient: true }) as const);
    const noAgent = vi.fn(async () => ({ ok: false, message: 'No Agent for this chat' }) as const);

    expect(await agentTabProfile(failing, 'conv-1')).toEqual({ profile: temporaryProfile('conv-1'), final: false });
    expect(await agentTabProfile(noAgent, 'conv-1')).toEqual({ profile: temporaryProfile('conv-1'), final: true });
    expect(await agentTabProfile(resolveAgent, undefined)).toEqual({ profile: DEFAULT_AGENT_PROFILE, final: true });
  });

  it('gives a VA Bot chat its Agent profile and every regular chat its own temporary session', async () => {
    const vaBot = vi.fn(async () => ({ ok: true, agentId: 'bare:agent-1' }) as const);
    const builtInDefault = vi.fn(async () => ({ ok: true, agentId: 'aion-default-agent' }) as const);
    const adoptedDefault = vi.fn(async () => ({ ok: true, agentId: 'bare:adopted' }) as const);
    const isDefaultAgent = vi.fn(async (agentId: string) => agentId === 'bare:adopted');

    expect(await agentTabProfile(vaBot, 'conv-1', isDefaultAgent)).toEqual({
      profile: { kind: 'agent', agentId: 'bare:agent-1' },
      final: true,
    });
    expect(await agentTabProfile(builtInDefault, 'conv-2', isDefaultAgent)).toEqual({
      profile: temporaryProfile('conv-2'),
      final: true,
    });
    expect(await agentTabProfile(adoptedDefault, 'conv-3', isDefaultAgent)).toEqual({
      profile: temporaryProfile('conv-3'),
      final: true,
    });
    // Two regular chats never share a session.
    expect(temporaryPartition('conv-2')).not.toBe(temporaryPartition('conv-3'));
    expect(temporaryPartition('conv-2').startsWith('persist:')).toBe(false);
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
    expect(emits.at(-1)?.[0]).toEqual([
      { webContentsId: 7, owner: 'user', sharedWith: null, profile: DEFAULT_AGENT_PROFILE },
    ]);
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

    // conv-a is a regular chat: its tab lives in its own temporary session.
    const tab = newTab(9, temporarySessionA);
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

  it('uses a temporary session for a chat without an Agent and the default Agent profile without a chat, never Personal', async () => {
    const relay = await start();
    const other = await connect(relay, 'a', { 'X-Aion-Conversation': 'conv-2' });
    const none = await connect(relay, 'b');
    void other('Target.createTarget', { url: 'https://a.test/' });
    void none('Target.createTarget', { url: 'https://b.test/' });

    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalledTimes(2));
    const profiles = h.ipcBridge.browser.openTabRequested.emit.mock.calls.map(([event]) => event.profile);
    expect(profiles).toEqual([temporaryProfile('conv-2'), DEFAULT_AGENT_PROFILE]);
  });

  it("fails createTarget at once when the pane can't set the Agent's browser profile up", async () => {
    const relay = await start();
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-1' });
    const created = send('Target.createTarget', { url: 'https://a.test/' });
    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalled());

    expect(
      await call('refuseTab', { url: 'https://a.test/', profile: { kind: 'agent', agentId: 'bare:agent-1' } })
    ).toEqual({ success: true });

    expect((await created).error?.message).toMatch(/browser profile/i);
    expect(
      await call('refuseTab', { url: 'https://a.test/', profile: { kind: 'agent', agentId: '../x' } })
    ).toMatchObject({
      success: false,
    });
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

describe('agent browser services: tabs an agent page opens', () => {
  const AGENT_PARTITION = agentPartition('bare:agent-1');
  const CONV_1_OWNER = { label: 'claude', conversationId: 'conv-1' };

  /** Tab `id`, opened by an agent of chat conv-1 (its Agent's profile). */
  const agentTab = async (id: number): Promise<void> => {
    const relay = await start();
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-1' });
    const created = send('Target.createTarget', { url: 'https://agent.test/' });
    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalled());
    newTab(id, agentSession).navigate('https://agent.test/');
    expect((await created).result).toEqual({ targetId: `wc-${id}` });
  };

  it("claims a popup of an agent's tab for that agent and chat", async () => {
    await agentTab(50);
    const popup = Object.assign(new FakeContents(51), { session: agentSession });

    hooks.current.popupCreated?.(50, popup as unknown as Electron.WebContents);

    expect((await ownership(51))?.owner).toMatchObject(CONV_1_OWNER);
  });

  it("opens an agent tab's _blank link in its chat and claims the tab once it appears", async () => {
    await agentTab(52);

    expect(hooks.current.tabRequested?.(52, 'https://link.test/', AGENT_PARTITION)).toEqual({
      conversationId: 'conv-1',
    });
    const tab = newTab(53, agentSession);
    expect((await ownership(53))?.owner).toBe('user');
    tab.navigate('https://link.test/');

    await vi.waitFor(async () => expect((await ownership(53))?.owner).toMatchObject(CONV_1_OWNER));
  });

  it("leaves a user tab's popup and _blank tab with the user", async () => {
    await start();
    newTab(54, personalSession);
    const popup = Object.assign(new FakeContents(55), { session: personalSession });

    hooks.current.popupCreated?.(54, popup as unknown as Electron.WebContents);
    expect(hooks.current.tabRequested?.(54, 'https://link.test/', 'persist:aionui-browser')).toBeUndefined();
    newTab(56, personalSession).navigate('https://link.test/');
    await Promise.resolve();

    expect((await ownership(55))?.owner).toBe('user');
    expect((await ownership(56))?.owner).toBe('user');
  });

  it('claims nothing once the pending _blank tab expired', async () => {
    await agentTab(57);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      hooks.current.tabRequested?.(57, 'https://late.test/', AGENT_PARTITION);
      await vi.advanceTimersByTimeAsync(15_001);
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }

    newTab(58, agentSession).navigate('https://late.test/');
    await Promise.resolve();

    expect((await ownership(58))?.owner).toBe('user');
  });

  it('stops following openers once agent control is off', async () => {
    await start();
    await services?.close();
    services = null;

    expect(hooks.current).toEqual({});
  });
});

describe('agent browser services: leave site', () => {
  /** Tab `id` opened by an agent of chat conv-1, and that agent's command sender. */
  const agentTab = async (id: number) => {
    const relay = await start();
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-1' });
    const created = send('Target.createTarget', { url: 'https://agent.test/' });
    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalled());
    const tab = newTab(id, agentSession, 'https://agent.test/');
    tab.navigate('https://agent.test/');
    expect((await created).result).toEqual({ targetId: `wc-${id}` });
    return { send, tab };
  };

  it("lets an agent's own tab leave unasked", async () => {
    await agentTab(70);
    expect(hooks.current.unloadBlocked?.(70)).toEqual({ kind: 'leave' });
  });

  it("still lets an agent's own tab leave unasked after the user only clicked in it", async () => {
    const { tab } = await agentTab(71);
    tab.emit('before-mouse-event', {}, { type: 'mouseDown', x: 1, y: 1 });
    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'Meta', code: 'MetaLeft' });
    expect(hooks.current.unloadBlocked?.(71)).toEqual({ kind: 'leave' });
  });

  it("asks, in the agent's chat too, once the user typed in an agent's own tab; a new page forgets it", async () => {
    const { tab } = await agentTab(75);
    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'a', code: 'KeyA' });

    const plan = hooks.current.unloadBlocked?.(75);
    if (plan?.kind !== 'ask' || !plan.askChat) throw new Error('expected a chat ask');
    const leave = plan.askChat(new AbortController().signal);
    const [open] = webuiConfirms.listConfirms('conv-1');
    expect(open).toMatchObject({ kind: 'leave', origin: 'https://agent.test' });
    expect(webuiConfirms.answerConfirm(open.id, false, false)).toBe(true);
    expect(await leave).toBe(false);

    tab.emit('did-navigate-in-page', {}, 'https://agent.test/#step-2', true);
    expect(hooks.current.unloadBlocked?.(75)).toMatchObject({ kind: 'ask' }); // same document: the text is still there
    tab.emit('did-navigate', {}, 'https://agent.test/next');
    expect(hooks.current.unloadBlocked?.(75)).toEqual({ kind: 'leave' });
  });

  it("still leaves unasked after the agent's own typing, which Electron also reports as a keyDown", async () => {
    const { send, tab } = await agentTab(76);
    tab.debugger.handler = (method, params) => {
      // Electron fires before-input-event for a CDP key while the command is in flight.
      const { type, key, code } = params as { type: string; key?: string; code?: string };
      if (method === 'Input.dispatchKeyEvent' && type !== 'keyUp') {
        tab.emit('before-input-event', {}, { type: 'keyDown', key, code });
      }
      return {};
    };
    const attached = await send('Target.attachToTarget', { targetId: 'wc-76', flatten: true });
    const sessionId = String(attached.result?.sessionId);

    const typed = await send(
      'Input.dispatchKeyEvent',
      { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' },
      sessionId
    );
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' }, sessionId);

    expect(typed.error).toBeUndefined();
    expect(hooks.current.unloadBlocked?.(76)).toEqual({ kind: 'leave' });
    // The same key from the user, once the agent's command settled, is the user's.
    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'a', code: 'KeyA' });
    expect(hooks.current.unloadBlocked?.(76)).toMatchObject({ kind: 'ask' });
  });

  it('asks on a user tab only on the desktop: no chat drives it', async () => {
    await start();
    newTab(72, personalSession);
    expect(hooks.current.unloadBlocked?.(72)).toEqual({ kind: 'ask' });
    expect(hooks.current.unloadBlocked?.(999)).toEqual({ kind: 'ask' });
  });

  it("asks a shared tab's question in the chat of the agent that used it; the chat's Leave answers it", async () => {
    const relay = await start();
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-a' });
    newTab(73, personalSession, 'https://bank.test/account');
    await call('share', { webContentsId: 73, on: true });
    expect(hooks.current.unloadBlocked?.(73)).toEqual({ kind: 'ask' }); // no agent used it yet
    const attached = await send('Target.attachToTarget', { targetId: 'wc-73', flatten: true });
    await send('Page.getFrameTree', {}, String(attached.result?.sessionId));

    const plan = hooks.current.unloadBlocked?.(73);
    if (plan?.kind !== 'ask' || !plan.askChat) throw new Error('expected a chat ask');
    const leave = plan.askChat(new AbortController().signal);
    const [open] = webuiConfirms.listConfirms('conv-a');
    expect(open).toEqual({ id: open.id, kind: 'leave', origin: 'https://bank.test', frameOrigin: null, label: '' });
    expect(webuiConfirms.answerConfirm(open.id, true, true)).toBe(true);
    expect(await leave).toBe(true);
  });

  it('lists and answers nothing on the phone once agent control stopped', async () => {
    const { tab } = await agentTab(77);
    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'a', code: 'KeyA' });
    const plan = hooks.current.unloadBlocked?.(77);
    if (plan?.kind !== 'ask' || !plan.askChat) throw new Error('expected a chat ask');
    void plan.askChat(new AbortController().signal);
    const [open] = webuiConfirms.listConfirms('conv-1');
    expect(open).toBeDefined();

    await services?.close();
    services = null;

    expect(webuiConfirms.listConfirms('conv-1')).toEqual([]);
    expect(webuiConfirms.answerConfirm(open.id, true, false)).toBe(false);
  });

  it('withdraws the chat ask once the desktop answered', async () => {
    const relay = await start();
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-a' });
    newTab(74, personalSession, 'https://bank.test/');
    await call('share', { webContentsId: 74, on: true });
    const attached = await send('Target.attachToTarget', { targetId: 'wc-74', flatten: true });
    await send('Page.getFrameTree', {}, String(attached.result?.sessionId));
    const plan = hooks.current.unloadBlocked?.(74);
    if (plan?.kind !== 'ask' || !plan.askChat) throw new Error('expected a chat ask');
    const settled = new AbortController();

    const leave = plan.askChat(settled.signal);
    expect(webuiConfirms.listConfirms('conv-a')).toHaveLength(1);
    settled.abort();

    expect(await leave).toBe(false);
    expect(webuiConfirms.listConfirms('conv-a')).toEqual([]);
  });
});

describe('agent browser services: tab hygiene', () => {
  it("closes a chat's least recently used agent tab when its agent opens a 4th, through the pane's close", async () => {
    const relay = await start();
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-1' });
    for (const id of [80, 81, 82, 83]) {
      const created = send('Target.createTarget', { url: `https://site${id}.test/` });
      await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalledTimes(id - 79));
      newTab(id, agentSession).navigate(`https://site${id}.test/`);
      expect((await created).result).toEqual({ targetId: `wc-${id}` });
    }

    expect(h.ipcBridge.browser.closeTabRequested.emit.mock.calls).toEqual([[{ webContentsId: 80 }]]);
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

  it("gives the WebUI a chat's own asks without the agent's label, answered once, also on a shared tab", async () => {
    const relay = await start();
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-1' });
    const created = send('Target.createTarget', { url: 'https://shop.test/' });
    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalled());
    const tab = newTab(31, agentSession, 'https://shop.test/');
    tab.navigate('https://shop.test/');
    expect((await created).result).toEqual({ targetId: 'wc-31' });
    const shared = newTab(32, agentSession, 'https://bank.test/');
    await call('share', { webContentsId: 32, on: true });
    for (const [contents, origin] of [
      [tab, 'https://shop.test'],
      [shared, 'https://bank.test'],
    ] as const) {
      contents.debugger.handler = (method) =>
        method === 'Page.getFrameTree'
          ? { frameTree: { frame: { id: 'TOP', url: origin, securityOrigin: origin } } }
          : {};
    }
    const ask = async (id: number) => {
      const attached = await send('Target.attachToTarget', { targetId: `wc-${id}`, flatten: true });
      return send('AionRelay.requestConfirm', {
        webContentsId: id,
        label: 'Pay',
        sessionId: String(attached.result?.sessionId),
        frameId: 'TOP',
      });
    };

    const answer = ask(31);
    const sharedAnswer = ask(32);
    await vi.waitFor(async () => expect(((await call('getConfirmRequests')).data as unknown[]).length).toBe(2));
    const [open, sharedOpen] = webuiConfirms.listConfirms('conv-1');
    // Ruling R9: the shared tab's ask goes to the asking agent's chat too.
    expect(webuiConfirms.listConfirms('conv-1')).toEqual([
      { id: open.id, origin: 'https://shop.test', frameOrigin: 'https://shop.test', label: 'Pay' },
      { id: sharedOpen.id, origin: 'https://bank.test', frameOrigin: 'https://bank.test', label: 'Pay' },
    ]);
    expect(webuiConfirms.listConfirms('conv-2')).toEqual([]);

    expect(webuiConfirms.answerConfirm(open.id, true, false)).toBe(true);
    expect(webuiConfirms.answerConfirm(open.id, false, false)).toBe(false);
    expect((await answer).result).toEqual({ allow: true });
    expect(webuiConfirms.answerConfirm(sharedOpen.id, false, false)).toBe(true);
    expect((await sharedAnswer).result).toEqual({ allow: false });
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

describe('agent browser services: YOLO chats and "Always allow"', () => {
  const yolo = { on: true };
  const isYoloChat = vi.fn(async (conversationId: string) => conversationId === 'conv-1' && yolo.on);
  const asked = () => h.ipcBridge.agentBrowser.confirmRequested.emit.mock.calls.filter(([open]) => open.length > 0);
  const allowFile = () => {
    try {
      return readFileSync(path.join(homedir(), '.aionui', 'browser-allow.json'), 'utf8');
    } catch {
      return '';
    }
  };

  /** Chat conv-1's agent tab `id` on `origin`, with a frame PAY of `frameOrigin`; asks to click Publish, or runs a script. */
  const agentTabAt = async (id: number, origin: string, frameOrigin = origin) => {
    const relay = await start({ isYoloChat });
    const send = await connect(relay, 'claude', { 'X-Aion-Conversation': 'conv-1' });
    const created = send('Target.createTarget', { url: `${origin}/` });
    await vi.waitFor(() => expect(h.ipcBridge.browser.openTabRequested.emit).toHaveBeenCalled());
    const tab = newTab(id, agentSession, `${origin}/`);
    tab.navigate(`${origin}/`);
    expect((await created).result).toEqual({ targetId: `wc-${id}` });
    tab.debugger.handler = (method) =>
      method === 'Page.getFrameTree'
        ? {
            frameTree: {
              frame: { id: 'TOP', url: `${origin}/`, securityOrigin: origin },
              childFrames: [{ frame: { id: 'PAY', url: `${frameOrigin}/`, securityOrigin: frameOrigin } }],
            },
          }
        : {};
    const sessionId = String(
      (await send('Target.attachToTarget', { targetId: `wc-${id}`, flatten: true })).result?.sessionId
    );
    const click = async (frameId = 'TOP') =>
      (await send('AionRelay.requestConfirm', { webContentsId: id, label: 'Publish', sessionId, frameId })).result;
    const script = async () =>
      (
        await send('AionRelay.runScript', {
          webContentsId: id,
          sessionId,
          code: 'x',
          form: 'expression',
          world: 'page',
        })
      ).result;
    return { tab, click, script };
  };

  afterEach(() => {
    yolo.on = true;
  });

  it("allows a YOLO chat's risky clicks and page scripts with no ask, and remembers nothing", async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { click, script } = await agentTabAt(90, 'https://yolo-a.test');
    expect(await click()).toEqual({ allow: true });
    expect(await click('PAY')).toEqual({ allow: true });
    expect(await script()).toMatchObject({ allow: true });
    expect(isYoloChat).toHaveBeenCalledWith('conv-1');
    expect(asked()).toEqual([]);
    expect(allowFile()).not.toContain('yolo-a.test');
    info.mockRestore();
  });

  it('asks a Default-mode chat', async () => {
    yolo.on = false;
    const { click } = await agentTabAt(91, 'https://yolo-b.test');
    const answer = click();
    await vi.waitFor(() => expect(webuiConfirms.listConfirms('conv-1')).toHaveLength(1));
    expect(webuiConfirms.answerConfirm(webuiConfirms.listConfirms('conv-1')[0].id, false, false)).toBe(true);
    expect(await answer).toEqual({ allow: false });
  });

  it('still asks "Leave site?" in a YOLO chat once the user typed on the page', async () => {
    const { tab } = await agentTabAt(92, 'https://yolo-c.test');
    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'a', code: 'KeyA' });
    const plan = hooks.current.unloadBlocked?.(92);
    if (plan?.kind !== 'ask' || !plan.askChat) throw new Error('expected a chat ask');
    const leave = plan.askChat(new AbortController().signal);
    const [open] = webuiConfirms.listConfirms('conv-1');
    expect(open).toMatchObject({ kind: 'leave', origin: 'https://yolo-c.test' });
    expect(isYoloChat).not.toHaveBeenCalled();
    expect(webuiConfirms.answerConfirm(open.id, false, false)).toBe(true);
    expect(await leave).toBe(false);
  });

  it('"Always allow" from the pane, a chat card or the robot popup (IPC) stops the next click and script asks', async () => {
    yolo.on = false;
    const { click, script } = await agentTabAt(93, 'https://always-ipc.test');
    for (const act of [click, script]) {
      const first = act();
      await vi.waitFor(async () => expect(((await call('getConfirmRequests')).data as unknown[]).length).toBe(1));
      const [open] = (await call('getConfirmRequests')).data as Array<{ id: string }>;
      expect(await call('replyConfirm', { id: open.id, allow: true, alwaysForSite: true })).toEqual({ success: true });
      expect(await first).toMatchObject({ allow: true });
      const before = asked().length;
      expect(await act()).toMatchObject({ allow: true });
      expect(asked()).toHaveLength(before);
    }
    expect(JSON.parse(allowFile())).toMatchObject({
      origins: expect.arrayContaining(['https://always-ipc.test']),
      scriptOrigins: expect.arrayContaining(['https://always-ipc.test']),
    });
  });

  it('"Always allow" from the phone stops the next ask, a cross-origin frame as its page|frame pair', async () => {
    yolo.on = false;
    const { click } = await agentTabAt(94, 'https://always-web.test', 'https://always-pay.test');
    const first = click('PAY');
    await vi.waitFor(() => expect(webuiConfirms.listConfirms('conv-1')).toHaveLength(1));
    const [open] = webuiConfirms.listConfirms('conv-1');
    expect(open).toMatchObject({ origin: 'https://always-web.test', frameOrigin: 'https://always-pay.test' });
    expect(webuiConfirms.answerConfirm(open.id, true, true)).toBe(true);
    expect(await first).toEqual({ allow: true });

    expect(await click('PAY')).toEqual({ allow: true });
    expect(webuiConfirms.listConfirms('conv-1')).toEqual([]);
    // The pair never covers the page's own controls.
    const top = click('TOP');
    await vi.waitFor(() => expect(webuiConfirms.listConfirms('conv-1')).toHaveLength(1));
    expect(webuiConfirms.answerConfirm(webuiConfirms.listConfirms('conv-1')[0].id, false, false)).toBe(true);
    expect(await top).toEqual({ allow: false });
  });
});

describe('agent browser services: user input', () => {
  /** Tab `id` shared with a connected agent, with that agent's session on it. */
  const sharedTab = async (id: number) => {
    const relay = await start();
    const send = await connect(relay, 'claude');
    const tab = newTab(id);
    await call('share', { webContentsId: id, on: true });
    const session = String(
      (await send('Target.attachToTarget', { targetId: `wc-${id}`, flatten: true })).result?.sessionId
    );
    return { send, tab, session };
  };
  const userInputs = () => h.ipcBridge.agentBrowser.userInput.emit.mock.calls.map(([event]) => event);

  it("tells the pane about the user's keys and clicks in a tab, at most once a second per tab", async () => {
    const { tab } = await sharedTab(12);
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      tab.emit('before-input-event', {}, { type: 'keyDown', key: 'a', code: 'KeyA' });
      tab.emit('before-input-event', {}, { type: 'keyDown', key: 'b', code: 'KeyB' });
      now.mockReturnValue(10_999);
      tab.emit('before-mouse-event', {}, { type: 'mouseDown', x: 1, y: 1 });
      expect(userInputs()).toEqual([{ webContentsId: 12, at: 10_000 }]);

      now.mockReturnValue(11_000);
      tab.emit('before-mouse-event', {}, { type: 'mouseDown', x: 1, y: 1 });
      expect(userInputs()).toEqual([
        { webContentsId: 12, at: 10_000 },
        { webContentsId: 12, at: 11_000 },
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it('ignores modifier keys, key-ups and mouse moves', async () => {
    const { tab } = await sharedTab(13);
    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
    tab.emit('before-input-event', {}, { type: 'keyUp', key: 'a', code: 'KeyA' });
    tab.emit('before-mouse-event', {}, { type: 'mouseMove', x: 1, y: 1 });
    expect(userInputs()).toEqual([]);
  });

  it("never reports the agent's own keys and clicks, which Electron also reports while its command is in flight", async () => {
    const { send, tab, session } = await sharedTab(14);
    tab.debugger.handler = (method, params) => {
      const { type, key, code, x, y } = params as { type: string; key?: string; code?: string; x?: number; y?: number };
      if (method === 'Input.dispatchKeyEvent' && type === 'keyDown') {
        tab.emit('before-input-event', {}, { type: 'keyDown', key, code });
      }
      if (method === 'Input.dispatchMouseEvent' && type === 'mousePressed') {
        tab.emit('before-mouse-event', {}, { type: 'mouseDown', x, y });
      }
      return {};
    };

    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }, session);
    await send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 },
      session
    );
    expect(userInputs()).toEqual([]);

    // The user's own click once the agent's command settled still counts.
    tab.emit('before-mouse-event', {}, { type: 'mouseDown', x: 5, y: 5 });
    expect(userInputs()).toEqual([{ webContentsId: 14, at: expect.any(Number) }]);
  });

  it("a user click or key on an agent's tab does not block the agent's next Input.dispatchMouseEvent", async () => {
    const relay = await start();
    const send = await connect(relay, 'claude');
    const tab = newTab(11);
    await call('share', { webContentsId: 11, on: true });
    const session = String(
      (await send('Target.attachToTarget', { targetId: 'wc-11', flatten: true })).result?.sessionId
    );

    tab.emit('before-mouse-event', {}, { type: 'mouseDown', x: 20, y: 40 });
    tab.emit('before-input-event', {}, { type: 'keyDown', key: 'a', code: 'KeyA' });
    const click = { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 };
    const reply = await send('Input.dispatchMouseEvent', click, session);

    expect(reply.error).toBeUndefined();
    expect(tab.debugger.sendCommand.mock.calls.map(([method]) => method)).toContain('Input.dispatchMouseEvent');
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

describe('agent browser services: WebUI browser view', () => {
  it('streams a tab the agent is attached to over the same debugger, and goes away with the relay', async () => {
    const relay = await start();
    const send = await connect(relay, 'claude');
    const tab = newTab(40);
    await call('share', { webContentsId: 40, on: true });
    expect((await send('Target.attachToTarget', { targetId: 'wc-40', flatten: true })).error).toBeUndefined();
    const peer = { sendBinary: vi.fn(), sendText: vi.fn(), close: vi.fn() };

    const stream = await getBrowserViewService()?.openStream('wc-40', peer);

    expect(stream).toBeDefined();
    expect(stream && 'error' in stream).toBe(false);
    expect(tab.debugger.isAttached()).toBe(true);
    if (stream && 'close' in stream) stream.close();
    await services?.close();
    services = null;
    expect(getBrowserViewService()).toBeNull();
  });
});

describe('agent browser services: closing', () => {
  it('turning agent control off closes open phone streams and detaches them', async () => {
    await start();
    const tab = newTab(41);
    await call('share', { webContentsId: 41, on: true });
    const peer = { sendBinary: vi.fn(), sendText: vi.fn(), close: vi.fn() };
    const stream = await getBrowserViewService()?.openStream('wc-41', peer);
    expect(stream && 'error' in stream).toBe(false);
    expect(tab.debugger.isAttached()).toBe(true);

    await services?.close();
    services = null;

    expect(peer.sendText).toHaveBeenLastCalledWith(JSON.stringify({ type: 'closed', reason: 'not-allowed' }));
    expect(peer.close).toHaveBeenCalledTimes(1);
    expect(tab.debugger.isAttached()).toBe(false);
  });
});

describe('chatIsYolo: the read-only runtime mode (R14)', () => {
  it('reads the live mode without starting a runtime; an unknown chat (404) is asked, with no warning', async () => {
    const { chatIsYolo } = await import('@process/services/agentBrowser/services');
    const { BackendHttpError } = await import('@/common/adapter/httpBridge');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.ipcBridge.conversation.runtimeMode.invoke
      .mockResolvedValueOnce({ mode: 'bypassPermissions', live: true, backend: 'claude' })
      .mockRejectedValueOnce(new BackendHttpError({ method: 'GET', path: '/x', status: 404, body: '' }));

    expect(await chatIsYolo('yolo-chat')).toBe(true);
    expect(h.ipcBridge.conversation.runtimeMode.invoke).toHaveBeenCalledWith({ conversation_id: 'yolo-chat' });
    expect(await chatIsYolo('gone-chat')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
