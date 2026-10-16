import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateTabWaiter, normalizeTabUrl, offerNewTab } from '@process/services/agentBrowser/tabWaiter';
import { FakeContents } from './relay/fakes';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CreateTabWaiter', () => {
  it('pairs a new tab with the request for the url its first main-frame navigation goes to', async () => {
    const waiter = new CreateTabWaiter<FakeContents>();
    const a = waiter.wait('https://a.test', 1000);
    const b = waiter.wait('https://b.test/x', 1000);
    const tabB = new FakeContents(2);
    const tabA = new FakeContents(1);
    offerNewTab(waiter, tabB);
    offerNewTab(waiter, tabA);

    tabB.navigate('https://b.test/ad-frame', false); // a subframe is not the tab's navigation
    tabB.navigate('https://b.test/x');
    tabA.navigate('https://a.test/');

    await expect(a).resolves.toBe(tabA);
    await expect(b).resolves.toBe(tabB);
  });

  it('never hands out a tab nobody asked for (a user tab opened during the wait)', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waiter = new CreateTabWaiter<FakeContents>();
    const agent = waiter.wait('https://agent.test/', 1000);
    const userTab = new FakeContents(1);
    offerNewTab(waiter, userTab);
    userTab.navigate('https://user.test/');
    const agentTab = new FakeContents(2);
    offerNewTab(waiter, agentTab);
    agentTab.navigate('https://agent.test/');

    await expect(agent).resolves.toBe(agentTab);

    const unanswered = waiter.wait('https://other.test/', 100);
    const assertion = expect(unanswered).rejects.toThrow('tab-create-timeout');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(waiter.waiting).toBe(false);
  });

  it("hands a tab only to a request for its own profile's partition", async () => {
    const waiter = new CreateTabWaiter<FakeContents>();
    const agentTab = waiter.wait('https://a.test/', 1000, 'conv-1', 'persist:aionui-agent-x');
    const personalTab = new FakeContents(1);
    const wrongAgentTab = new FakeContents(2);
    const rightTab = new FakeContents(3);

    expect(waiter.offer(personalTab, 'https://a.test/', 'persist:aionui-browser')).toBe(false);
    expect(waiter.offer(wrongAgentTab, 'https://a.test/', 'persist:aionui-agent-y')).toBe(false);
    expect(waiter.offer(wrongAgentTab, 'https://a.test/')).toBe(false);
    offerNewTab(waiter, rightTab, 'persist:aionui-agent-x');
    rightTab.navigate('https://a.test/');

    await expect(agentTab).resolves.toBe(rightTab);
  });

  it('gives two requests for the same url one tab each, oldest first', async () => {
    const waiter = new CreateTabWaiter<FakeContents>();
    const first = waiter.wait('about:blank', 1000);
    const second = waiter.wait('about:blank', 1000);
    expect(waiter.offer(new FakeContents(1), 'about:blank')).toBe(true);
    expect(waiter.offer(new FakeContents(2), 'about:blank')).toBe(true);
    expect(waiter.offer(new FakeContents(3), 'about:blank')).toBe(false);
    expect((await first).id).toBe(1);
    expect((await second).id).toBe(2);
  });

  it('does not watch new tabs while nobody waits', () => {
    const tab = new FakeContents(1);
    offerNewTab(new CreateTabWaiter<FakeContents>(), tab);
    expect(tab.listenerCount('did-start-navigation')).toBe(0);
  });

  it('normalizes urls before comparing them', () => {
    expect(normalizeTabUrl('HTTPS://Example.com')).toBe('https://example.com/');
    expect(normalizeTabUrl('about:blank')).toBe('about:blank');
    expect(normalizeTabUrl('not a url')).toBe('not a url');
  });
});
