/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isMotionReduced, useAnimating, useMotionPreference } from '@/renderer/hooks/ui/useMotion';

/** A matchMedia that answers `prefers-reduced-motion: reduce` with `reduce`. */
const stubMotionQuery = (reduce: boolean) =>
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({ matches: reduce && query.includes('reduce'), media: query }))
  );

/** A node kept mounted while it plays its exit, the way the panes use the hook. */
const Fading: React.FC<{ open: boolean }> = ({ open }) => {
  const changing = useAnimating(open, 200);
  if (!open && !changing) return null;
  return <div data-testid='node' data-closing={!open || undefined} />;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.reduceMotion;
});

describe('isMotionReduced', () => {
  it('lets motion run when the OS does not ask for less', () => {
    stubMotionQuery(false);
    expect(isMotionReduced()).toBe(false);
  });

  it('turns motion off for the OS preference', () => {
    stubMotionQuery(true);
    expect(isMotionReduced()).toBe(true);
  });

  it("turns motion off for the app's own setting even when the OS allows it", () => {
    stubMotionQuery(false);
    document.documentElement.dataset.reduceMotion = 'true';
    expect(isMotionReduced()).toBe(true);
  });

  it('treats a window without matchMedia (jsdom) as reduced, so tests see changes at once', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(isMotionReduced()).toBe(true);
  });
});

describe('useMotionPreference', () => {
  it("mirrors the app's Reduce motion setting on <html data-reduce-motion>", () => {
    const Probe: React.FC<{ reduce: boolean }> = ({ reduce }) => {
      useMotionPreference(reduce);
      return null;
    };
    const { rerender } = render(<Probe reduce />);
    expect(document.documentElement.dataset.reduceMotion).toBe('true');

    rerender(<Probe reduce={false} />);
    expect(document.documentElement.dataset.reduceMotion).toBeUndefined();
  });
});

describe('useAnimating as an exit hook', () => {
  it('keeps a closing node mounted until its exit has run', () => {
    stubMotionQuery(false);
    const { rerender } = render(<Fading open />);

    rerender(<Fading open={false} />);
    expect(screen.getByTestId('node')).toHaveAttribute('data-closing');

    act(() => vi.advanceTimersByTime(199));
    expect(screen.getByTestId('node')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('node')).toBeNull();
  });

  it('removes the node in the same render under reduced motion', () => {
    stubMotionQuery(true);
    const { rerender } = render(<Fading open />);

    rerender(<Fading open={false} />);

    expect(screen.queryByTestId('node')).toBeNull();
  });

  it('keeps a node reopened mid-exit and restarts the timer on the next close', () => {
    stubMotionQuery(false);
    const { rerender } = render(<Fading open />);
    rerender(<Fading open={false} />);
    act(() => vi.advanceTimersByTime(150));

    rerender(<Fading open />);
    expect(screen.getByTestId('node')).not.toHaveAttribute('data-closing');
    rerender(<Fading open={false} />);
    act(() => vi.advanceTimersByTime(150));

    expect(screen.getByTestId('node')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(50));
    expect(screen.queryByTestId('node')).toBeNull();
  });
});
