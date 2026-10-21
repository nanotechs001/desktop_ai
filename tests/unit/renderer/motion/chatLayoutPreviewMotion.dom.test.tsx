/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The side-by-side preview slides out instead of vanishing, and maximizing eases its width; under reduced motion (and
// in jsdom without matchMedia) both land at once. What the motion looks like is checked by eye, not here.

let mockIsMobile = false;
const mockPreview = { isOpen: true, isVaBotMode: false, isVaChatCollapsed: true, toggleVaChat: vi.fn() };
let mockFilesCollapsed = true;

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: mockIsMobile }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => mockPreview,
  PreviewPanel: ({ closing }: { closing?: boolean }) => (
    <div data-testid='preview-panel' data-panel-closing={closing || undefined}>
      preview
    </div>
  ),
}));

vi.mock('@/renderer/pages/conversation/components/ChatLayout/MobileWorkspaceOverlay', () => ({
  default: () => <div data-testid='mobile-workspace-overlay' />,
}));

vi.mock('@/renderer/pages/conversation/components/ChatLayout/WorkspacePanelHeader', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/pages/conversation/components/ChatTitleEditor', () => ({
  default: () => <div>title</div>,
}));

vi.mock('@/renderer/components/agent/AgentLogoIcon', () => ({
  AgentLogoIcon: () => <div>logo</div>,
}));

vi.mock('@/renderer/components/layout/FlexFullContainer', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/renderer/hooks/ui/useResizableSplit', () => ({
  useResizableSplit: () => ({
    splitRatio: 60,
    setSplitRatio: vi.fn(),
    createDragHandle: () => null,
  }),
}));

vi.mock('@/renderer/pages/conversation/hooks/useContainerWidth', () => ({
  useContainerWidth: () => ({ containerRef: { current: null }, containerWidth: 800 }),
}));

vi.mock('@/renderer/pages/conversation/hooks/useLayoutConstraints', () => ({
  useLayoutConstraints: () => undefined,
}));

vi.mock('@/renderer/pages/conversation/hooks/useTitleRename', () => ({
  useTitleRename: () => ({
    editingTitle: false,
    setEditingTitle: vi.fn(),
    titleDraft: '',
    setTitleDraft: vi.fn(),
    renameLoading: false,
    canRenameTitle: false,
    submitTitleRename: vi.fn(),
  }),
}));

vi.mock('@/renderer/pages/conversation/hooks/useWorkspaceCollapse', () => ({
  useWorkspaceCollapse: () => ({ rightSiderCollapsed: mockFilesCollapsed, setRightSiderCollapsed: vi.fn() }),
}));

import ChatLayout from '@/renderer/pages/conversation/components/ChatLayout';
import { MOTION_MS } from '@/renderer/hooks/ui/useMotion';

const ui = () => (
  <ChatLayout sider={<div>sider</div>} workspaceEnabled={false}>
    <div>chat body</div>
  </ChatLayout>
);

const stubMotionQuery = (reduce: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: reduce && query.includes('reduce'), media: query }))
  );

const panelBox = () => screen.getByTestId('preview-panel').parentElement?.parentElement as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  mockPreview.isOpen = true;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mockPreview.isOpen = true;
  Object.assign(mockPreview, { isMaximized: false });
});

describe('ChatLayout preview motion', () => {
  it('slides the closed preview out with its last tab still drawn, then removes it', () => {
    stubMotionQuery(false);
    const { rerender } = render(ui());
    expect(panelBox()).toHaveClass('preview-reveal');
    expect(panelBox().style.getPropertyValue('--preview-reveal-size')).toBe('40%');

    mockPreview.isOpen = false;
    rerender(ui());
    expect(panelBox()).toHaveAttribute('data-closing');
    expect(screen.getByTestId('preview-panel')).toHaveAttribute('data-panel-closing');

    act(() => vi.advanceTimersByTime(MOTION_MS.base));
    expect(screen.queryByTestId('preview-panel')).toBeNull();
  });

  it('removes the closed preview at once under reduced motion', () => {
    stubMotionQuery(true);
    const { rerender } = render(ui());

    mockPreview.isOpen = false;
    rerender(ui());

    expect(screen.queryByTestId('preview-panel')).toBeNull();
  });

  it('eases a maximize only while it runs, holding the chat at its width, then hides the chat', () => {
    stubMotionQuery(false);
    const { rerender } = render(ui());
    expect(panelBox()).not.toHaveAttribute('data-resizing');

    Object.assign(mockPreview, { isMaximized: true });
    rerender(ui());
    expect(panelBox()).toHaveAttribute('data-resizing');
    expect(panelBox().style.flexBasis).toBe('100%');
    expect(screen.getByText('chat body')).toBeVisible();

    act(() => vi.advanceTimersByTime(MOTION_MS.slow));
    expect(panelBox()).not.toHaveAttribute('data-resizing');
    expect(screen.getByText('chat body')).not.toBeVisible();
  });
});
