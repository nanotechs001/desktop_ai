import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayClient, retryDelayMs } from '@process/resources/builtinMcp/aionBrowser/relayClient';
import { FakeRelay } from './fakeRelay';

let relay: FakeRelay;
const clients: RelayClient[] = [];

const newClient = (env: NodeJS.ProcessEnv = relay.env, agentName?: () => string | undefined): RelayClient => {
  const client = new RelayClient(env, agentName);
  clients.push(client);
  return client;
};

beforeEach(async () => {
  relay = await FakeRelay.start();
  relay.on('Target.createTarget', () => ({ targetId: 'wc-7' }));
  relay.on('Target.attachToTarget', (params) => ({ sessionId: `s-${String(params.targetId)}` }));
  relay.on('Target.closeTarget', () => ({ success: true }));
  relay.on('Emulation.setFocusEmulationEnabled', () => ({}));
  relay.on('AionRelay.listTabs', () => ({
    tabs: [{ targetId: 'wc-7', title: 'T', url: 'https://example.com/', owner: 'agent' }],
  }));
});

afterEach(async () => {
  clients.splice(0).forEach((client) => client.close());
  await relay.stop();
});

describe('RelayClient', () => {
  it('connects with the Bearer header (never a query token) and a sanitized agent label', async () => {
    const client = newClient(relay.env, () => 'Claude Code/1.0 <x>');
    await client.connect(relay.env);
    expect(relay.labels).toEqual(['aion-browser-Claude Code1.0 x']);
    expect(relay.refused).toEqual([]);
  });

  it('names its chat to the relay (X-Aion-Conversation from AIONUI_CONVERSATION_ID), only when the id is well formed', async () => {
    const named = { ...relay.env, AIONUI_CONVERSATION_ID: 'conv_A-1' };
    await newClient(named).connect(named);
    await newClient().connect(relay.env);
    const malformed = { ...relay.env, AIONUI_CONVERSATION_ID: 'a\nb' };
    await newClient(malformed).connect(malformed);
    expect(relay.conversations).toEqual(['conv_A-1', undefined, undefined]);
  });

  it('falls back to the plain label and caps the label at 40 characters', async () => {
    await newClient().connect(relay.env);
    await newClient(relay.env, () => 'a'.repeat(100)).connect(relay.env);
    expect(relay.labels[0]).toBe('aion-browser');
    expect(relay.labels[1]).toHaveLength(40);
  });

  it('throws relay-env-missing without url or token, and refuses a non-loopback url', async () => {
    await expect(newClient({}).connect({})).rejects.toThrow('relay-env-missing');
    await expect(newClient().connect({ AION_BROWSER_RELAY_URL: relay.url })).rejects.toThrow('relay-env-missing');
    const remote = { AION_BROWSER_RELAY_URL: 'ws://example.com:1/', AION_BROWSER_RELAY_TOKEN: 'x' };
    await expect(newClient(remote).connect(remote)).rejects.toThrow('relay-env-missing');
  });

  it('reports a wrong token as a refused connection', async () => {
    const env = { ...relay.env, AION_BROWSER_RELAY_TOKEN: 'wrong' };
    await expect(newClient(env).connect(env)).rejects.toThrow(/401/);
    expect(relay.refused).toEqual(['Bearer wrong']);
  });

  it('opens, lists, closes tabs and caches one session per tab', async () => {
    const client = newClient();
    expect(await client.openTab('https://example.com')).toBe('wc-7');
    expect(relay.callsTo('Target.createTarget')).toEqual([{ url: 'https://example.com' }]);

    expect(await client.listTabs()).toEqual([{ tab: 'wc-7', title: 'T', url: 'https://example.com/', owner: 'agent' }]);

    expect(await client.session('wc-7')).toBe('s-wc-7');
    expect(await client.session('wc-7')).toBe('s-wc-7');
    expect(relay.callsTo('Target.attachToTarget')).toEqual([{ targetId: 'wc-7', flatten: true }]);
    // Focus emulation keeps a background tab rendering (rAF, menus); once per session.
    expect(relay.requests.filter((r) => r.method === 'Emulation.setFocusEmulationEnabled')).toEqual([
      { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true }, sessionId: 's-wc-7' },
    ]);

    await client.closeTab('wc-7');
    expect(relay.callsTo('Target.closeTarget')).toEqual([{ targetId: 'wc-7' }]);
    await client.session('wc-7');
    expect(relay.callsTo('Target.attachToTarget')).toHaveLength(2); // the cache forgot the closed tab
  });

  it('reconnects on the next call after the relay closes the socket (1012) and forgets old sessions', async () => {
    const client = newClient();
    await client.session('wc-7');
    client.currentTab = 'wc-7';
    relay.dropClients(1012);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(await client.listTabs()).toHaveLength(1);
    expect(relay.labels).toHaveLength(2);
    expect(client.currentTab).toBeNull();
    expect(client.takeReconnected()).toBe(true);
    expect(client.takeReconnected()).toBe(false);
    await client.session('wc-7');
    expect(relay.callsTo('Target.attachToTarget')).toHaveLength(2);
  });

  it('does not report the first connection as a reconnect', async () => {
    const client = newClient();
    await client.listTabs();
    expect(client.takeReconnected()).toBe(false);
  });

  it('forgets a tab the user closed: its session and the current tab', async () => {
    const client = newClient();
    await client.session('wc-7');
    client.currentTab = 'wc-7';
    relay.emit('Target.targetDestroyed', { targetId: 'wc-7' });
    await vi.waitFor(() => expect(client.currentTab).toBeNull());
    await client.session('wc-7');
    expect(relay.callsTo('Target.attachToTarget')).toHaveLength(2);
  });

  it('re-attaches after the relay detaches a tab session (stop sharing, crash), keeping the current tab', async () => {
    const client = newClient();
    expect(await client.session('wc-7')).toBe('s-wc-7');
    client.currentTab = 'wc-7';
    // A child (OOPIF) detach carries the parent session; even with the tab's own session id in its params it is no tab detach.
    relay.emit('Target.detachedFromTarget', { sessionId: 's-wc-7', targetId: 'FRAME' }, 's-wc-7');
    await client.session('wc-7');
    expect(relay.callsTo('Target.attachToTarget')).toHaveLength(1);
    relay.emit('Target.detachedFromTarget', { sessionId: 's-wc-7', targetId: 'wc-7' });
    await vi.waitFor(async () => {
      await client.session('wc-7');
      expect(relay.callsTo('Target.attachToTarget')).toHaveLength(2);
    });
    expect(client.currentTab).toBe('wc-7');
  });

  it('backs off between failed connects, capped at 5 seconds', async () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(retryDelayMs)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000]);

    const env = { ...relay.env };
    await relay.stop();
    const client = newClient(env);
    await expect(client.listTabs()).rejects.toThrow();
    const started = Date.now();
    await expect(client.listTabs()).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(200); // waited out the backoff before retrying
    relay = await FakeRelay.start(); // afterEach stops it
  });

  it('surfaces relay errors as CdpError messages', async () => {
    relay.on('Target.createTarget', () => {
      throw new Error('tab-create-timeout');
    });
    await expect(newClient().openTab('https://example.com')).rejects.toThrow('tab-create-timeout');
  });
});
