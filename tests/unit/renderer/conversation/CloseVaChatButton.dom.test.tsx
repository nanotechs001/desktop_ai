/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  preview: { isVaBotMode: true, isOpen: true, isVaChatCollapsed: false, toggleVaChat: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview', () => ({ usePreviewContext: () => h.preview }));

import CloseVaChatButton from '@/renderer/pages/conversation/components/ChatLayout/CloseVaChatButton';

afterEach(() => {
  cleanup();
  h.preview = { isVaBotMode: true, isOpen: true, isVaChatCollapsed: false, toggleVaChat: vi.fn() };
});

describe('the VA chat close button', () => {
  it('hides the chat under the browser in one click, like dragging it to the bottom', () => {
    render(<CloseVaChatButton />);

    fireEvent.click(screen.getByRole('button', { name: 'preview.hideChat' }));

    expect(h.preview.toggleVaChat).toHaveBeenCalledTimes(1);
  });

  it('is only there while the chat sits under an open browser pane', () => {
    for (const state of [{ isVaBotMode: false }, { isOpen: false }, { isVaChatCollapsed: true }]) {
      h.preview = { ...h.preview, ...state };
      const { unmount } = render(<CloseVaChatButton />);
      expect(screen.queryByRole('button', { name: 'preview.hideChat' })).toBeNull();
      unmount();
    }
  });
});
