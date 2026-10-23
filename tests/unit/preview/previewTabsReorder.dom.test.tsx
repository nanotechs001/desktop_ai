/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tabs in the preview strip are dragged to reorder them, Chrome-style: a tab stays inside its group
 * (pinned or not), and the close button sits at the tab's end so every tab reads as the same width.
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import PreviewTabs from '@renderer/pages/conversation/Preview/components/PreviewPanel/PreviewTabs';
import type { PreviewTab } from '@renderer/pages/conversation/Preview/components/PreviewPanel/PreviewTabs';
import { moveTabTo } from '@renderer/pages/conversation/Preview/context/PreviewContext';

const TABS: PreviewTab[] = [
  { id: 'p', title: 'pinned', pinned: true },
  { id: 'a', title: 'alpha' },
  { id: 'b', title: 'beta' },
  { id: 'c', title: 'gamma' },
];

const renderTabs = (onMoveTab = vi.fn()) => {
  render(
    <PreviewTabs
      tabs={TABS}
      activeTabId='a'
      tabFadeState={{ left: false, right: false }}
      tabsContainerRef={React.createRef<HTMLDivElement>()}
      onSwitchTab={vi.fn()}
      onCloseTab={vi.fn()}
      onContextMenu={vi.fn()}
      onMoveTab={onMoveTab}
    />
  );
  return onMoveTab;
};

const tab = (id: string) => screen.getByTestId(`preview-tab-${id}`);

/** jsdom has no DataTransfer; the strip only needs these members. */
const dataTransfer = () => {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'all',
    dropEffect: 'none',
    types: [] as string[],
    setData(type: string, value: string) {
      store.set(type, value);
      this.types = [...store.keys()];
    },
    getData: (type: string) => store.get(type) ?? '',
  };
};

const drag = (fromId: string, toId: string) => {
  const transfer = dataTransfer();
  fireEvent.dragStart(tab(fromId), { dataTransfer: transfer });
  fireEvent.dragOver(tab(toId), { dataTransfer: transfer });
  fireEvent.drop(tab(toId), { dataTransfer: transfer });
  fireEvent.dragEnd(tab(fromId), { dataTransfer: transfer });
};

describe('preview tab reordering', () => {
  it('makes tabs draggable when the strip can reorder them', () => {
    renderTabs();
    expect(tab('a')).toHaveAttribute('draggable', 'true');
  });

  it('moves a dragged tab onto the tab it is dropped on', () => {
    const onMoveTab = renderTabs();
    drag('a', 'c');
    expect(onMoveTab).toHaveBeenCalledWith('a', 'c');
  });

  it('ignores a drop across the pinned boundary', () => {
    const onMoveTab = renderTabs();
    drag('b', 'p');
    expect(onMoveTab).not.toHaveBeenCalled();
  });

  it('ignores a drop on the tab being dragged', () => {
    const onMoveTab = renderTabs();
    drag('b', 'b');
    expect(onMoveTab).not.toHaveBeenCalled();
  });

  it('keeps the close button at the end of the tab, so tabs read as equal width', () => {
    renderTabs();
    expect(screen.getByTitle('alpha').parentElement).toHaveClass('flex-1');
  });
});

describe('moveTabTo', () => {
  const ids = (tabs: { id: string }[]) => tabs.map((t) => t.id);
  const list = [{ id: 'p', metadata: { pinned: true } }, { id: 'a' }, { id: 'b' }, { id: 'c' }] as Parameters<
    typeof moveTabTo
  >[0];

  it('moves right onto the target, like Chrome', () => {
    expect(ids(moveTabTo(list, 'a', 'c'))).toEqual(['p', 'b', 'c', 'a']);
  });

  it('moves left onto the target', () => {
    expect(ids(moveTabTo(list, 'c', 'a'))).toEqual(['p', 'c', 'a', 'b']);
  });

  it('leaves the order alone across the pinned boundary or for unknown ids', () => {
    expect(moveTabTo(list, 'a', 'p')).toBe(list);
    expect(moveTabTo(list, 'a', 'missing')).toBe(list);
    expect(moveTabTo(list, 'a', 'a')).toBe(list);
  });
});

describe('pinned tab icon', () => {
  it("falls back to the page's first letter when the site icon fails to load, so the tile never goes blank", () => {
    render(
      <PreviewTabs
        tabs={[{ id: 'p', title: 'Artifact', pinned: true, favicon: 'http://127.0.0.1:1/favicon.ico' }]}
        activeTabId='p'
        tabFadeState={{ left: false, right: false }}
        tabsContainerRef={React.createRef<HTMLDivElement>()}
        onSwitchTab={vi.fn()}
        onCloseTab={vi.fn()}
        onContextMenu={vi.fn()}
      />
    );
    const tile = () => tab('p').querySelector('[data-testid="pinned-tile"]') as HTMLElement;
    expect(tile().querySelector('img')).not.toBeNull();

    fireEvent.error(tile().querySelector('img') as HTMLImageElement);

    expect(tile().querySelector('img')).toBeNull();
    expect(tile().textContent).toBe('A');
  });
});
