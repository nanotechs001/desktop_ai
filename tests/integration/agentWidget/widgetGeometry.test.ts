/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  carriedPosition,
  computePlacement,
  landingY,
  getTaskbarEdge,
  getWalkTrack,
  followTarget,
  stepToward,
  ratioFromX,
  resolveSlot,
  xFromRatio,
  type DisplayLike,
} from '@process/pet/agentWidget/widgetGeometry';

const display = (workArea: DisplayLike['workArea'], bounds = { x: 0, y: 0, width: 1920, height: 1080 }) => ({
  id: 1,
  bounds,
  workArea,
});
const BOTTOM = display({ x: 0, y: 0, width: 1920, height: 1040 });
const TOP = display({ x: 0, y: 40, width: 1920, height: 1040 });
const LEFT = display({ x: 60, y: 0, width: 1860, height: 1080 });
const HIDDEN = display({ x: 0, y: 0, width: 1920, height: 1080 });
const BOT = 88;
const POPUP = { width: 380, height: 540 };

describe('taskbar detection', () => {
  it('reads the taskbar edge from the bounds/work-area gap', () => {
    expect(getTaskbarEdge(BOTTOM)).toBe('bottom');
    expect(getTaskbarEdge(TOP)).toBe('top');
    expect(getTaskbarEdge(LEFT)).toBe('left');
    expect(getTaskbarEdge(display({ x: 0, y: 0, width: 1860, height: 1080 }))).toBe('right');
    expect(getTaskbarEdge(HIDDEN)).toBe('none');
  });

  it('stands the robot on the taskbar top border for a bottom taskbar', () => {
    const track = getWalkTrack(BOTTOM, BOT);
    expect(track.y + BOT).toBe(1040); // robot's feet touch the taskbar's top edge
    expect(track.minX).toBe(0);
    expect(track.maxX).toBe(1920 - BOT);
  });

  it('hangs below a top taskbar and keeps side taskbars on the bottom edge', () => {
    expect(getWalkTrack(TOP, BOT).y).toBe(40);
    const left = getWalkTrack(LEFT, BOT);
    expect(left.y).toBe(1080 - BOT);
    expect(left.minX).toBe(60);
  });

  it('honours secondary-monitor offsets', () => {
    const second = {
      id: 2,
      bounds: { x: 1920, y: -200, width: 2560, height: 1440 },
      workArea: { x: 1920, y: -200, width: 2560, height: 1392 },
    };
    const track = getWalkTrack(second, BOT);
    expect(track.y).toBe(-200 + 1392 - BOT);
    expect(track.minX).toBe(1920);
    expect(xFromRatio(track, 1)).toBe(1920 + 2560 - BOT);
  });
});

describe('position ratio', () => {
  const track = getWalkTrack(BOTTOM, BOT);
  it('round-trips and clamps', () => {
    expect(ratioFromX(track, xFromRatio(track, 0.3))).toBeCloseTo(0.3, 2);
    expect(xFromRatio(track, 5)).toBe(track.maxX);
    expect(ratioFromX(track, -100)).toBe(0);
  });
  it('defaults new robots toward the right, away from the start button', () => {
    expect(xFromRatio(track, undefined)).toBe(Math.round(0.85 * track.maxX));
  });
});

describe('placement', () => {
  const track = getWalkTrack(BOTTOM, BOT);

  it('collapsed window is exactly the robot box', () => {
    const p = computePlacement(track, 500, BOT, false, POPUP);
    expect(p.bounds).toEqual({ x: 500, y: track.y, width: BOT, height: BOT });
  });

  it('opens right when it fits and keeps the robot at the same screen x', () => {
    const p = computePlacement(track, 500, BOT, true, POPUP);
    expect(p.popupSide).toBe('right');
    expect(p.popupVertical).toBe('above');
    expect(p.bounds.x + p.botOffsetX).toBe(500);
    expect(p.bounds.y + p.bounds.height).toBe(1040); // still resting on the taskbar
  });

  it('flips left near the right edge and stays inside the work area', () => {
    const p = computePlacement(track, track.maxX, BOT, true, POPUP);
    expect(p.popupSide).toBe('left');
    expect(p.bounds.x + p.bounds.width).toBeLessThanOrEqual(1920);
    expect(p.bounds.x + p.botOffsetX).toBe(track.maxX);
  });

  it('opens below a top taskbar', () => {
    const p = computePlacement(getWalkTrack(TOP, BOT), 100, BOT, true, POPUP);
    expect(p.popupVertical).toBe('below');
    expect(p.bounds.y).toBe(40);
  });

  it('clamps an off-screen robot back onto the track', () => {
    expect(computePlacement(track, -500, BOT, false, POPUP).bounds.x).toBe(0);
    expect(computePlacement(track, 99_999, BOT, false, POPUP).bounds.x).toBe(track.maxX);
  });
});

describe('spacing between robots', () => {
  const track = getWalkTrack(BOTTOM, BOT);
  const minDist = Math.round(BOT * 1.25);

  it('keeps a free slot as-is', () => {
    expect(resolveSlot(500, [100, 900], track, BOT)).toBe(500);
  });

  it('never stacks a robot on top of another', () => {
    const x = resolveSlot(500, [500], track, BOT);
    expect(Math.abs(x - 500)).toBeGreaterThanOrEqual(minDist);
  });

  it('groups compactly instead of overlapping exactly when the track is full', () => {
    const tiny = getWalkTrack(display({ x: 0, y: 0, width: 200, height: 1040 }), BOT);
    const x = resolveSlot(50, [0, 112], tiny, BOT);
    expect(x).not.toBe(0);
    expect(x).not.toBe(112);
    expect(x).toBeGreaterThanOrEqual(tiny.minX);
    expect(x).toBeLessThanOrEqual(tiny.maxX);
  });
});

describe('carrying and dropping', () => {
  const wa = BOTTOM.workArea;

  it('keeps the grab offset and stays inside the work area, never over the taskbar', () => {
    expect(carriedPosition({ x: 800, y: 500 }, { x: 40, y: 30 }, wa, BOT)).toEqual({ x: 760, y: 470 });
    expect(carriedPosition({ x: 5, y: 1075 }, { x: 40, y: 30 }, wa, BOT)).toEqual({ x: 0, y: 1040 - BOT });
  });

  it('falls with gravity onto the track by the impact time, then rests', () => {
    expect(landingY(300, 952, 0, 360)).toBe(300);
    const mid = landingY(300, 952, 180, 360);
    expect(mid).toBeGreaterThan(300);
    expect(mid).toBeLessThan(300 + (952 - 300) / 2); // accelerating: less than half way at half time
    expect(landingY(300, 952, 360, 360)).toBe(952);
    expect(landingY(300, 952, 700, 360)).toBe(952);
  });
});

describe('following the mouse', () => {
  const track = getWalkTrack(BOTTOM, BOT);

  it('stands with its centre under the mouse, kept on the track', () => {
    expect(followTarget(600, track, BOT)).toBe(600 - BOT / 2);
    expect(followTarget(5, track, BOT)).toBe(track.minX);
    expect(followTarget(1919, track, BOT)).toBe(track.maxX);
  });

  it('strolls a short stretch toward the target, never past it', () => {
    expect(stepToward(100, 1000, track, () => 0.5)).toBe(200); // 40 + 60 px
    expect(stepToward(1000, 100, track, () => 0)).toBe(960); // 40 px to the left
    expect(stepToward(100, 120, track, () => 1)).toBe(120); // stops at the target
  });
});
