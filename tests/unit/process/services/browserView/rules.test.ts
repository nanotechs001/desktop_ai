import { describe, expect, it } from 'vitest';
import type { TabOwnership } from '@/common/types/browser';
import { isViewable, viewableTabs } from '@process/services/agentBrowser/relay/browserView/rules';
import type { RelayTargetInfo } from '@process/services/agentBrowser/relay/targetRegistry';

const PERSONAL = { kind: 'personal' } as const;
const tab = (webContentsId: number, patch: Partial<TabOwnership> = {}): TabOwnership => ({
  webContentsId,
  owner: 'user',
  sharedWith: null,
  paused: false,
  profile: PERSONAL,
  ...patch,
});
const agentTab = (id: number, conversationId?: string, patch: Partial<TabOwnership> = {}): TabOwnership =>
  tab(id, { owner: { clientId: `c${id}`, label: 'claude', conversationId }, ...patch });
const target = (id: number): RelayTargetInfo => ({
  targetId: `wc-${id}`,
  type: 'page',
  title: `Title ${id}`,
  url: `https://example.com/${id}`,
  attached: false,
  canAccessOpener: false,
});

describe('isViewable', () => {
  it('refuses a user tab, allows an agent tab, allows a shared user tab', () => {
    expect(isViewable(tab(1))).toBe(false);
    expect(isViewable(agentTab(2, 'conv'))).toBe(true);
    expect(isViewable(tab(3, { sharedWith: 'all' }))).toBe(true);
  });
});

describe('viewableTabs', () => {
  it("keeps only the conversation's agent tabs, with title, url and paused", () => {
    const all = [
      tab(1),
      agentTab(2, 'conv'),
      agentTab(3, 'other'),
      agentTab(4, undefined),
      agentTab(5, 'conv', { paused: true }),
    ];
    expect(viewableTabs(all, [1, 2, 3, 4, 5].map(target), 'conv')).toEqual([
      { id: 'wc-2', title: 'Title 2', url: 'https://example.com/2', paused: false },
      { id: 'wc-5', title: 'Title 5', url: 'https://example.com/5', paused: true },
    ]);
  });

  it('drops a user tab even when it is shared (no conversation owns it)', () => {
    expect(viewableTabs([tab(1, { sharedWith: 'all' })], [target(1)], 'conv')).toEqual([]);
  });

  it('drops a tab with no matching target', () => {
    expect(viewableTabs([agentTab(2, 'conv')], [], 'conv')).toEqual([]);
  });
});
