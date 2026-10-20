/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Zooming the live picture on the phone (1x to 4x, by pinch, buttons or double-tap) and panning it while zoomed.
 * Only the picture is transformed; taps still land on the right spot of the desktop page.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', async () => {
  const { preview } = await import('./liveViewHarness');
  return { useOptionalPreviewContext: () => preview.value };
});

import WebviewHost from '@/renderer/components/media/WebviewHost';
import {
  type FakeWebSocket,
  layOutView,
  liveImage,
  openSocket,
  setUpLiveView,
  showFrame,
  tearDownLiveView,
} from './liveViewHarness';

beforeEach(setUpLiveView);

afterEach(() => {
  cleanup();
  tearDownLiveView();
});

/** A live view with a frame on screen, drawn 200x100 at the top-left; timers faked from here on. */
const zoomable = async (): Promise<{ ws: FakeWebSocket; surface: HTMLElement }> => {
  render(<WebviewHost url='https://one.example/' liveView />);
  const ws = await openSocket();
  await showFrame(ws);
  const surface = screen.getByRole('img');
  layOutView(surface);
  vi.useFakeTimers();
  return { ws, surface };
};

/** The picture's current zoom, read back from its CSS transform. */
const view = (): { x: number; y: number; scale: number } => {
  const transform = liveImage().parentElement?.style.transform ?? '';
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(transform);
  if (!match) return { x: 0, y: 0, scale: 1 };
  // `+ 0` turns -0 into 0.
  return { x: Number(match[1]) + 0, y: Number(match[2]) + 0, scale: Number(match[3]) };
};

const button = (name: string): HTMLElement => screen.getByRole('button', { name });

const down = (surface: HTMLElement, pointerId: number, x: number, y: number) =>
  fireEvent.pointerDown(surface, { pointerId, clientX: x, clientY: y });
const move = (surface: HTMLElement, pointerId: number, x: number, y: number) =>
  fireEvent.pointerMove(surface, { pointerId, clientX: x, clientY: y });
const up = (surface: HTMLElement, pointerId: number, x: number, y: number) =>
  fireEvent.pointerUp(surface, { pointerId, clientX: x, clientY: y });

const tapAt = (surface: HTMLElement, x: number, y: number): void => {
  down(surface, 1, x, y);
  up(surface, 1, x, y);
};

const doubleTapAt = (surface: HTMLElement, x: number, y: number): void => {
  tapAt(surface, x, y);
  act(() => vi.advanceTimersByTime(100));
  tapAt(surface, x, y);
  act(() => vi.advanceTimersByTime(300));
};

const drag = (surface: HTMLElement, from: [number, number], to: [number, number]): void => {
  down(surface, 1, ...from);
  move(surface, 1, ...to);
  up(surface, 1, ...to);
};

describe('BrowserLiveView zoom buttons', () => {
  it('zoom in stops at 4x and zoom out at 1x', async () => {
    await zoomable();
    expect(button('preview.browser.liveZoomOut')).toBeDisabled();

    for (let i = 0; i < 10; i++) fireEvent.click(button('preview.browser.liveZoomIn'));
    expect(view().scale).toBe(4);
    expect(button('preview.browser.liveZoomIn')).toBeDisabled();

    for (let i = 0; i < 10; i++) fireEvent.click(button('preview.browser.liveZoomOut'));
    expect(view()).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('reset zoom goes back to 1x', async () => {
    await zoomable();
    fireEvent.click(button('preview.browser.liveZoomIn'));
    expect(view().scale).toBeGreaterThan(1);

    fireEvent.click(button('preview.browser.liveZoomReset'));

    expect(view()).toEqual({ x: 0, y: 0, scale: 1 });
  });
});

describe('BrowserLiveView pinch', () => {
  it('two fingers spreading zoom around their midpoint, within 1x..4x, and send nothing', async () => {
    const { ws, surface } = await zoomable();

    down(surface, 1, 50, 50);
    down(surface, 2, 100, 50);
    move(surface, 2, 150, 50);
    // Distance 50 -> 100: 2x, keeping the point under the fingers' midpoint (75,50 -> 100,50) under them.
    expect(view()).toEqual({ x: -50, y: -50, scale: 2 });

    move(surface, 2, 1000, 50);
    expect(view().scale).toBe(4);
    move(surface, 2, 51, 50);
    expect(view().scale).toBe(1);
    up(surface, 2, 51, 50);
    up(surface, 1, 50, 50);
    act(() => vi.advanceTimersByTime(300));

    expect(ws.messages().filter((m) => m.type === 'tap' || m.type === 'scroll')).toEqual([]);
  });
});

describe('BrowserLiveView double-tap', () => {
  it('at 1x zooms to 2x at that point, and sends no tap', async () => {
    const { ws, surface } = await zoomable();

    doubleTapAt(surface, 50, 25);

    expect(view()).toEqual({ x: -50, y: -25, scale: 2 });
    expect(ws.messages().filter((m) => m.type === 'tap')).toEqual([]);
  });

  it('when zoomed resets to 1x', async () => {
    const { ws, surface } = await zoomable();
    fireEvent.click(button('preview.browser.liveZoomIn'));

    doubleTapAt(surface, 100, 50);

    expect(view()).toEqual({ x: 0, y: 0, scale: 1 });
    expect(ws.messages().filter((m) => m.type === 'tap')).toEqual([]);
  });
});

describe('BrowserLiveView pan and taps while zoomed', () => {
  it('a drag pans the picture, clamped to its edges', async () => {
    const { surface } = await zoomable();
    doubleTapAt(surface, 50, 25);

    drag(surface, [100, 50], [80, 40]);
    expect(view()).toEqual({ x: -70, y: -35, scale: 2 });

    drag(surface, [100, 50], [900, 900]);
    expect(view()).toEqual({ x: 0, y: 0, scale: 2 });

    drag(surface, [100, 50], [-900, -900]);
    // The 2x picture is 400x200 in a 200x100 view.
    expect(view()).toEqual({ x: -200, y: -100, scale: 2 });
  });

  it('a tap at 2x and panned maps through the zoom to the right spot on the page', async () => {
    const { ws, surface } = await zoomable();
    doubleTapAt(surface, 50, 25);

    tapAt(surface, 100, 50);
    act(() => vi.advanceTimersByTime(300));
    drag(surface, [100, 50], [80, 40]);
    tapAt(surface, 100, 50);
    act(() => vi.advanceTimersByTime(300));

    // (100,50) at 2x shifted by (-50,-25) is page point (75,37.5) of 200x100; then shifted by (-70,-35): (85,42.5).
    expect(ws.messages().filter((m) => m.type === 'tap')).toEqual([
      { type: 'tap', nx: 0.375, ny: 0.375 },
      { type: 'tap', nx: 0.425, ny: 0.425 },
    ]);
  });

  it('a drag at 1x sends scroll; a drag while zoomed does not', async () => {
    const { ws, surface } = await zoomable();

    drag(surface, [100, 80], [100, 55]);
    expect(ws.messages().filter((m) => m.type === 'scroll')).toHaveLength(1);

    fireEvent.click(button('preview.browser.liveZoomIn'));
    drag(surface, [100, 80], [100, 55]);
    act(() => vi.advanceTimersByTime(300));

    expect(ws.messages().filter((m) => m.type === 'scroll')).toHaveLength(1);
    expect(ws.messages().filter((m) => m.type === 'tap')).toEqual([]);
  });
});
