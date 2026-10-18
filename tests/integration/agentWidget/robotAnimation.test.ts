/**
 * @vitest-environment jsdom
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));

import type { AgentAnimationState } from '@/common/types/agent/agentWidget';
import { DROP_IMPACT_MS, ROBOT_ANIMATION_MANIFEST, robotAnimationMs } from '@/common/types/agent/agentWidget';
import {
  applyStreamFrame,
  applyTurnCompleted,
  clipDone,
  clipFrameAt,
  createActivity,
  IDLE_REST_CYCLE_MS,
  NORMAL_PRESENTATION,
  presentationAdvance,
  presentationOnChatChange,
  resolveRobotVisual,
  ROBOT_CLIPS,
  TURN_FRAME_COUNT,
  TURN_FRAME_MS,
  turnEndsAt,
  turnFrameAt,
  type Presentation,
  type RobotInteraction,
  type RobotVisual,
} from '@renderer/pages/agentWidget/agentAnimationState';
import RobotSprite, { FADE_MS, StripCache, stripCache } from '@renderer/pages/agentWidget/RobotSprite';
import { useRobotPresentation } from '@renderer/pages/agentWidget/useAgentAnimationState';

const ROOT = path.resolve(__dirname, '../../..');
const ASSETS = path.join(ROOT, 'assets/ai-robot-concepts/animation-strips-v1');
const WIDGET_SRC = path.join(ROOT, 'packages/desktop/src/renderer/pages/agentWidget');
const STATES = [
  'idle',
  'thinking',
  'talking',
  'sleeping',
  'searching',
  'working',
  'turn-to-user',
  'facing-user',
  'dragging',
  'drop-landing',
  'appearing',
  'disappearing',
];

const stationary = { facing: 'right', moving: false, reduceMotion: false } as const;
const open = (p: Presentation, now = 0) => presentationOnChatChange(p, true, false, now);
const close = (p: Presentation, now: number) => presentationOnChatChange(p, false, false, now);
/** The time at the middle of turn frame `n` (never on a frame boundary). */
const frameTime = (n: number) => (n + 0.5) * TURN_FRAME_MS;

describe('30 FPS manifest', () => {
  const states = ROBOT_ANIMATION_MANIFEST.states as Record<string, { frameCount: number; framePattern: string }>;

  it('1. loads all 12 states, 334 frames, matching the frame files on disk', () => {
    expect(Object.keys(states).toSorted()).toEqual(STATES.toSorted());
    let total = 0;
    for (const [state, spec] of Object.entries(states)) {
      const dir = path.join(ASSETS, path.dirname(spec.framePattern));
      expect(
        readdirSync(dir).filter((f) => f.endsWith('.png')),
        state
      ).toHaveLength(spec.frameCount);
      total += spec.frameCount;
    }
    expect(total).toBe(334);
  });

  it('2. no robot code assumes eight frames or a fixed frame duration', () => {
    for (const file of ['RobotSprite.tsx', 'RobotSprite.module.css', 'agentAnimationState.ts', 'index.tsx']) {
      const src = readFileSync(path.join(WIDGET_SRC, file), 'utf8');
      expect(src, file).not.toMatch(/steps\(\s*8/);
      expect(src, file).not.toMatch(/\*\s*8\b/);
      expect(src, file).not.toMatch(/FRAME_COUNT\s*=\s*8/);
    }
  });

  it('3. every visual state plays its manifest-defined frame count', () => {
    for (const clip of Object.values(ROBOT_CLIPS)) {
      expect(clip.frameCount).toBe(states[clip.asset].frameCount);
    }
    expect(TURN_FRAME_COUNT).toBe(states['turn-to-user'].frameCount);
  });

  it('4. plays at 30 FPS without completing faster than before', () => {
    for (const [state, spec] of Object.entries(ROBOT_ANIMATION_MANIFEST.states)) {
      expect(spec.fps).toBe(30);
      const ms = robotAnimationMs(state as keyof typeof ROBOT_ANIMATION_MANIFEST.states);
      expect(Math.abs(ms - spec.outputDurationMs)).toBeLessThan(1);
      // Interpolated frames never shorten the drawn animation.
      expect(ms).toBeGreaterThanOrEqual(spec.sourceDurationMs);
    }
    for (const [strip, clip] of Object.entries(ROBOT_CLIPS)) {
      if (strip !== 'idle') expect(clip.fps, strip).toBe(30);
      expect(clipFrameAt(clip, clip.durationMs - 1), strip).toBe(clip.frameCount - 1);
    }
  });

  it('5. looping states wrap around', () => {
    const clip = ROBOT_CLIPS.thinking;
    expect(clip.loop).toBe(true);
    expect(clipFrameAt(clip, 0)).toBe(0);
    expect(clipFrameAt(clip, 1000 / 30 + 1)).toBe(1);
    expect(clipFrameAt(clip, clip.durationMs + 1)).toBe(0);
    expect(clipDone(clip, 60_000)).toBe(false);
  });

  it('6. one-shot states stop on their final frame', () => {
    for (const strip of ['appearing', 'disappearing', 'drop-landing', 'turn-to-user'] as const) {
      const clip = ROBOT_CLIPS[strip];
      expect(clip.loop).toBe(false);
      expect(clipFrameAt(clip, 60_000)).toBe(clip.frameCount - 1);
      expect(clipDone(clip, clip.durationMs - 1)).toBe(false);
      expect(clipDone(clip, clip.durationMs)).toBe(true);
    }
  });

  it('24. idle keeps its resting cycle; sleeping keeps its drawn tempo', () => {
    expect(ROBOT_CLIPS.idle.durationMs).toBe(IDLE_REST_CYCLE_MS);
    expect(IDLE_REST_CYCLE_MS).toBe(2800);
    expect(ROBOT_CLIPS.sleeping.durationMs).toBeCloseTo(states.sleeping.frameCount * (1000 / 30), 6);
    expect(ROBOT_CLIPS.sleeping.loop).toBe(true);
  });

  it('touches down on drop-landing’s impact keyframe, inside the landing', () => {
    expect(DROP_IMPACT_MS).toBe(360);
    expect(DROP_IMPACT_MS).toBeLessThan(robotAnimationMs('drop-landing'));
  });
});

describe('turn to face the user', () => {
  it('26. clicking an idle bot plays every turn-to-user frame in order, then faces the user', () => {
    const p = open(NORMAL_PRESENTATION);
    const frames = Array.from({ length: TURN_FRAME_COUNT }, (_, n) => turnFrameAt(p, frameTime(n)));
    expect(frames).toEqual(Array.from({ length: TURN_FRAME_COUNT }, (_, n) => n));
    expect(resolveRobotVisual(p, 'idle', stationary)).toMatchObject({ strip: 'turn-to-user', turn: p });
    expect(presentationAdvance(p, frameTime(TURN_FRAME_COUNT - 1))).toBe(p);
    const facing = presentationAdvance(p, turnEndsAt(p));
    expect(facing.mode).toBe('facingUser');
    expect(resolveRobotVisual(facing, 'idle', stationary)).toMatchObject({ strip: 'facing-user', frame: null });
  });

  it('the turn keeps its pacing: all frames over the manifest duration', () => {
    expect(turnEndsAt(open(NORMAL_PRESENTATION))).toBeCloseTo(robotAnimationMs('turn-to-user'), 6);
  });

  it('closing the chat plays the turn in reverse, then returns to normal', () => {
    const facing = presentationAdvance(open(NORMAL_PRESENTATION), 10_000);
    const away = close(facing, 20_000);
    const frames = Array.from({ length: TURN_FRAME_COUNT }, (_, n) => turnFrameAt(away, 20_000 + frameTime(n)));
    expect(frames).toEqual(Array.from({ length: TURN_FRAME_COUNT }, (_, n) => TURN_FRAME_COUNT - 1 - n));
    expect(presentationAdvance(away, turnEndsAt(away))).toEqual(NORMAL_PRESENTATION);
  });

  it('rapid open/close reverses from the frame currently shown', () => {
    const turning = open(NORMAL_PRESENTATION);
    const away = close(turning, frameTime(5));
    expect(away).toMatchObject({ mode: 'turningAway', frame: 5 });
    const reopened = open(away, frameTime(5) + frameTime(2));
    expect(reopened).toMatchObject({ mode: 'turningToUser', frame: 3 });
  });

  it('runtime work outranks the front-facing loop; idle returns to it', () => {
    const facing = presentationAdvance(open(NORMAL_PRESENTATION), 10_000);
    const outranks: AgentAnimationState[] = ['error', 'offline', 'listening', 'talking', 'searching', 'working'];
    for (const state of [...outranks, 'thinking' as const]) {
      expect(resolveRobotVisual(facing, state, stationary).strip).toBe(state);
    }
    for (const state of ['idle', 'sleeping', 'notification'] as const) {
      expect(resolveRobotVisual(facing, state, stationary).strip).toBe('facing-user');
    }
  });
});

describe('interaction states', () => {
  const with_ = (interaction: Partial<RobotInteraction>, p: Presentation = NORMAL_PRESENTATION, state = 'working') =>
    resolveRobotVisual(p, state as AgentAnimationState, {
      ...stationary,
      interaction: { lifecycle: null, dragPhase: 'none', ...interaction },
    });
  const turning = open(NORMAL_PRESENTATION);

  it('priority: disappearing > appearing > dragging > dropLanding > turningToUser > runtime', () => {
    expect(with_({ lifecycle: 'disappearing', dragPhase: 'dragging' }, turning).strip).toBe('disappearing');
    expect(with_({ lifecycle: 'appearing', dragPhase: 'dragging' }, turning).strip).toBe('appearing');
    expect(with_({ dragPhase: 'dragging' }, turning).strip).toBe('dragging');
    expect(with_({ dragPhase: 'landing' }, turning).strip).toBe('drop-landing');
    expect(with_({}, turning).strip).toBe('turn-to-user');
    expect(with_({}).strip).toBe('working');
  });

  it('before the window shows, the first appearing frame is held (no default image)', () => {
    expect(with_({ lifecycle: 'pending' })).toMatchObject({ strip: 'appearing', frame: 0 });
  });

  it('8/19. once interactions end, the current runtime state shows again', () => {
    expect(with_({ dragPhase: 'dragging' }, NORMAL_PRESENTATION, 'searching').strip).toBe('dragging');
    expect(with_({}, NORMAL_PRESENTATION, 'searching').strip).toBe('searching');
    expect(with_({}, NORMAL_PRESENTATION, 'idle').strip).toBe('idle');
  });

  it('dragging and landing never hop, even while the robot was walking', () => {
    const opts = { facing: 'left', moving: true, reduceMotion: false } as const;
    for (const dragPhase of ['dragging', 'landing'] as const) {
      const visual = resolveRobotVisual(NORMAL_PRESENTATION, 'idle', {
        ...opts,
        interaction: { lifecycle: null, dragPhase },
      });
      expect(visual).toMatchObject({ hopping: false, mirrored: true, panicking: false });
    }
  });

  it('23. reduced motion: fades instead of materializing, a static dragging pose, still loops', () => {
    const rm = (interaction: Partial<RobotInteraction>, state: AgentAnimationState = 'idle') =>
      resolveRobotVisual(NORMAL_PRESENTATION, state, {
        facing: 'right',
        moving: true,
        reduceMotion: true,
        interaction: { lifecycle: null, dragPhase: 'none', ...interaction },
      });
    expect(rm({ lifecycle: 'appearing' })).toMatchObject({
      strip: 'appearing',
      frame: ROBOT_CLIPS.appearing.frameCount - 1,
      fade: 'in',
    });
    expect(rm({ lifecycle: 'disappearing' })).toMatchObject({ strip: 'disappearing', fade: 'out' });
    expect(rm({ dragPhase: 'dragging' })).toMatchObject({ strip: 'dragging', frame: 0 });
    expect(rm({})).toMatchObject({ strip: 'idle', frame: 0, hopping: false });
    expect(presentationOnChatChange(NORMAL_PRESENTATION, true, true, 0).mode).toBe('facingUser');
  });
});

describe('direction, hopping and panicking (unchanged)', () => {
  it('26. moving right faces right; moving left mirrors; stationary keeps the last direction', () => {
    const p = NORMAL_PRESENTATION;
    expect(resolveRobotVisual(p, 'idle', { facing: 'right', moving: true, reduceMotion: false })).toMatchObject({
      mirrored: false,
      hopping: true,
    });
    expect(resolveRobotVisual(p, 'idle', { facing: 'left', moving: true, reduceMotion: false }).mirrored).toBe(true);
    expect(resolveRobotVisual(p, 'idle', { facing: 'left', moving: false, reduceMotion: false })).toMatchObject({
      mirrored: true,
      hopping: false,
    });
  });

  it('only walking idle hops — never sleeping or busy', () => {
    for (const state of ['sleeping', 'thinking', 'working', 'error', 'offline'] as const) {
      expect(
        resolveRobotVisual(NORMAL_PRESENTATION, state, { facing: 'right', moving: true, reduceMotion: false }).hopping
      ).toBe(false);
    }
  });

  it('panics while waiting on the user, only with the chat closed', () => {
    const blocked = applyStreamFrame(createActivity(0), { type: 'permission', data: {} }, 1);
    expect(blocked.awaitingUser).toBe(true);
    expect(applyTurnCompleted(blocked, { status: 'finished' }, false, 2).awaitingUser).toBe(false);
    const opts = { facing: 'right', moving: false, reduceMotion: false, awaitingUser: true } as const;
    expect(resolveRobotVisual(NORMAL_PRESENTATION, 'thinking', opts)).toMatchObject({ panicking: true });
    expect(resolveRobotVisual(open(NORMAL_PRESENTATION), 'thinking', opts).panicking).toBe(false);
  });
});

describe('shared strip cache', () => {
  const fakeLoader = () => {
    const loads: string[] = [];
    const disposed: string[] = [];
    const loader = (src: string) => {
      loads.push(src);
      return { ready: Promise.resolve(), dispose: () => disposed.push(src) };
    };
    return { loader, loads, disposed };
  };

  it('21. decodes each strip once, keyed by strip only — never per agent', async () => {
    const { loader, loads } = fakeLoader();
    const cache = new StripCache(loader, 4);
    await Promise.all([cache.load('idle.webp'), cache.load('idle.webp'), cache.load('working.webp')]);
    expect(loads).toEqual(['idle.webp', 'working.webp']);
    expect(cache.isReady('idle.webp')).toBe(true);
  });

  it('is bounded, evicting the least recently used strip nobody is showing', async () => {
    const { loader, disposed } = fakeLoader();
    const cache = new StripCache(loader, 2);
    await cache.load('a');
    cache.retain('a'); // on screen
    await cache.load('b');
    await cache.load('c');
    expect(cache.size).toBe(2);
    expect(disposed).toEqual(['b']);
    expect(cache.isReady('a')).toBe(true);
    cache.release('a');
    await cache.load('d');
    expect(disposed).toEqual(['b', 'a']);
  });

  it('forgets a failed decode so it can be retried', async () => {
    let fail = true;
    const cache = new StripCache(
      () => ({ ready: fail ? Promise.reject(new Error('x')) : Promise.resolve(), dispose: () => {} }),
      4
    );
    await expect(cache.load('a')).rejects.toThrow();
    fail = false;
    await cache.load('a');
    expect(cache.isReady('a')).toBe(true);
  });
});

describe('animation clock', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  const visual = (overrides: Partial<RobotVisual>): RobotVisual => ({
    strip: 'idle',
    frame: null,
    mirrored: false,
    hopping: false,
    panicking: false,
    ...overrides,
  });
  const mount = (v: RobotVisual, onClipEnd = vi.fn()) => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] });
    vi.spyOn(stripCache, 'isReady').mockReturnValue(true);
    const view = render(
      React.createElement(RobotSprite, { visual: v, state: 'idle', size: 88, reduceMotion: false, onClipEnd })
    );
    const sprite = view.container.querySelector('[data-strip]') as HTMLElement;
    return { ...view, sprite, onClipEnd };
  };
  const frameOf = (sprite: HTMLElement) => -parseFloat(sprite.style.backgroundPositionX) / 88;
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it('draws the strip sized to its frame count and picks frames from elapsed time', () => {
    const { sprite } = mount(visual({ strip: 'thinking' }));
    advance(20);
    expect(sprite.style.backgroundSize).toBe(`${ROBOT_CLIPS.thinking.frameCount * 88}px 88px`);
    expect(sprite.style.backgroundImage).toContain('thinking');
    const f0 = frameOf(sprite);
    advance(200);
    expect(frameOf(sprite) - f0).toBeGreaterThanOrEqual(5); // ~6 frames in 200 ms at 30 FPS
    expect(frameOf(sprite) - f0).toBeLessThanOrEqual(7);
  });

  it('plays appearing once, holds its final frame and reports the end once', () => {
    const { sprite, onClipEnd } = mount(visual({ strip: 'appearing' }));
    advance(robotAnimationMs('appearing') + 100);
    expect(frameOf(sprite)).toBe(ROBOT_CLIPS.appearing.frameCount - 1);
    advance(1_000);
    expect(onClipEnd).toHaveBeenCalledTimes(1);
    expect(onClipEnd).toHaveBeenCalledWith('appearing');
  });

  it('reduced-motion fades report their end after the fade', () => {
    const { onClipEnd } = mount(visual({ strip: 'disappearing', frame: 0, fade: 'out' }));
    advance(FADE_MS / 2);
    expect(onClipEnd).not.toHaveBeenCalled();
    advance(FADE_MS);
    expect(onClipEnd).toHaveBeenCalledWith('disappearing');
  });

  it('22. a hidden widget stops rendering, and nothing runs after it is destroyed', () => {
    const { sprite, unmount } = mount(visual({ strip: 'working' }));
    advance(50);
    expect(vi.getTimerCount()).toBe(1); // exactly one animation clock
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(vi.getTimerCount()).toBe(0);
    const frame = sprite.style.backgroundPositionX;
    advance(500);
    expect(sprite.style.backgroundPositionX).toBe(frame);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the previous frame up until the next strip is decoded', () => {
    const { sprite, rerender } = mount(visual({ strip: 'idle' }));
    advance(20);
    vi.mocked(stripCache.isReady).mockImplementation((src) => !src.includes('searching'));
    const load = vi.spyOn(stripCache, 'load').mockReturnValue(new Promise(() => {}));
    rerender(
      React.createElement(RobotSprite, {
        visual: visual({ strip: 'searching' }),
        state: 'searching',
        size: 88,
        reduceMotion: false,
      })
    );
    advance(100);
    expect(load).toHaveBeenCalledTimes(1);
    expect(sprite.style.backgroundImage).toContain('idle');
  });
});

describe('render layers', () => {
  const html = (v: RobotVisual) =>
    renderToStaticMarkup(React.createElement(RobotSprite, { visual: v, state: 'idle', size: 88, reduceMotion: false }));

  it('only the robot layer is mirrored — it holds no text or chat UI', () => {
    const markup = html({ strip: 'idle', frame: null, mirrored: true, hopping: true, panicking: false });
    expect(markup).toContain('data-facing="left"');
    expect(markup.replace(/<[^>]+>/g, '')).toBe('');
  });
});

describe('hop shape (CSS, unchanged)', () => {
  const css = readFileSync(path.join(WIDGET_SRC, 'RobotSprite.module.css'), 'utf8');
  const hop = css.slice(css.indexOf('@keyframes slime-hop'), css.indexOf('}\n}', css.indexOf('@keyframes slime-hop')));

  it('mirroring and squash keep the centre and the taskbar contact point', () => {
    expect(css).toMatch(/\.direction\[data-facing='left'\]\s*{\s*transform: scaleX\(-1\);/);
    expect(css).toMatch(/\.hop\s*{\s*transform-origin: 50% 100%;/);
    expect(css).toMatch(/\.hopping\s*{\s*animation: slime-hop 720ms infinite;/);
  });

  it('the hop never dips below the base and lands at scale 1', () => {
    const all = hop.match(/translateY\(/g) ?? [];
    const allowed = hop.match(/translateY\((0|calc\(var\(--hop-height, 8px\) \* -1\))\)/g) ?? [];
    expect(all.length).toBeGreaterThan(0);
    expect(allowed).toHaveLength(all.length);
    expect(hop).toMatch(/100% {\s*transform: translateY\(0\) scale\(1, 1\);/);
  });
});

describe('presentation hook', () => {
  afterEach(() => vi.useRealTimers());

  it('runs no timers of its own; the animation clock advances the turn', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'performance'] });
    const { result, rerender } = renderHook(({ chatOpen }) => useRobotPresentation(chatOpen, false), {
      initialProps: { chatOpen: false },
    });
    rerender({ chatOpen: true });
    expect(result.current[0].mode).toBe('turningToUser');
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(robotAnimationMs('turn-to-user') + 10);
      result.current[1]();
    });
    expect(result.current[0].mode).toBe('facingUser');
  });
});
