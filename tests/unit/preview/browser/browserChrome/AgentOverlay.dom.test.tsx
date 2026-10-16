/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActionEvent } from '@/common/types/browser';

import AgentOverlay, {
  AGENT_HIGHLIGHT_MS,
} from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/AgentOverlay';

const action = (patch: Partial<AgentActionEvent> = {}): AgentActionEvent => ({
  webContentsId: 7,
  clientLabel: 'Some Vendor',
  op: 'click',
  label: 'Buy now',
  rect: { x: 10, y: 60, width: 120, height: 32 },
  at: 1,
  ...patch,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AgentOverlay', () => {
  it('renders the action rect and label and has pointer-events none', () => {
    const { container } = render(<AgentOverlay action={action()} />);

    expect(screen.getByText('Buy now')).toBeTruthy();
    const layer = container.firstElementChild as HTMLElement;
    expect(layer.style.pointerEvents).toBe('none');
    const box = container.querySelector('[data-testid="agent-highlight"]') as HTMLElement;
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual([
      '10px',
      '60px',
      '120px',
      '32px',
    ]);
  });

  it('renders the label as text, never as HTML', () => {
    const { container } = render(<AgentOverlay action={action({ label: '<img src=x onerror=alert(1)>' })} />);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('disappears after the highlight time and comes back for the next action', () => {
    const { container, rerender } = render(<AgentOverlay action={action()} />);
    act(() => {
      vi.advanceTimersByTime(AGENT_HIGHLIGHT_MS);
    });
    expect(container.firstChild).toBeNull();

    rerender(<AgentOverlay action={action({ label: 'Next', at: 2 })} />);
    expect(screen.getByText('Next')).toBeTruthy();
  });

  it('draws nothing for an action without a rect, or no action', () => {
    const { container, rerender } = render(<AgentOverlay action={action({ rect: null })} />);
    expect(container.firstChild).toBeNull();
    rerender(<AgentOverlay action={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('clears its highlight timer on unmount', () => {
    const { unmount } = render(<AgentOverlay action={action()} />);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
