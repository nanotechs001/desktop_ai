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
      },
      browser: { openTabRequested: emitter(), closeTabRequested: emitter() },
    },
  };
});

vi.mock('@/common', () => ({ ipcBridge: h.ipcBridge }));
vi.mock('@process/services/browserSession/browserSession', () => ({
  onBrowserContentsCreated: (listener: (contents: unknown) => void) => {
    h.created.push(listener);
    return () => {};
  },
}));

const { startAgentBrowserServices } = await import('@process/services/agentBrowser/services');

type Services = NonNullable<Awaited<ReturnType<typeof startAgentBrowserServices>>>;
type Reply = { id: number; result?: Record<string, unknown>; error?: { message: string } };

let services: Services | null = null;
const sockets: WebSocket[] = [];

const start = async (): Promise<Services> => {
  const started = await startAgentBrowserServices({ enabled: true, blockedPorts: () => [] });
  if (!started) throw new Error('relay did not start');
  services = started;
  return started;
};

/** A new browser tab, as browserSession dispatches it. */
const newTab = (id: number): FakeContents => {
  const tab = new FakeContents(id);
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

const connect = async (relay: Services, label: string) => {
  const url = new URL(relay.url);
  url.searchParams.set('client', label);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${relay.token}` } });
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
