/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import classNames from 'classnames';
import type { AgentAnimationState, RobotAnimationName } from '@/common/types/agent/agentWidget';
import { isBotColor } from '@/common/types/agent/botColors';
import appearingStrip from '@renderer/assets/agentWidget/appearing.webp';
import disappearingStrip from '@renderer/assets/agentWidget/disappearing.webp';
import draggingStrip from '@renderer/assets/agentWidget/dragging.webp';
import dropLandingStrip from '@renderer/assets/agentWidget/drop-landing.webp';
import facingUserStrip from '@renderer/assets/agentWidget/facing-user.webp';
import idleStrip from '@renderer/assets/agentWidget/idle.webp';
import searchingStrip from '@renderer/assets/agentWidget/searching.webp';
import sleepingStrip from '@renderer/assets/agentWidget/sleeping.webp';
import talkingStrip from '@renderer/assets/agentWidget/talking.webp';
import thinkingStrip from '@renderer/assets/agentWidget/thinking.webp';
import turnToUserStrip from '@renderer/assets/agentWidget/turn-to-user.webp';
import workingStrip from '@renderer/assets/agentWidget/working.webp';
import {
  clipDone,
  clipFrameAt,
  ROBOT_CLIPS,
  turnEndsAt,
  turnFrameAt,
  type RobotStrip,
  type RobotVisual,
} from './agentAnimationState';
import styles from './RobotSprite.module.css';

/** One horizontal strip per manifest animation (tools/build-robot-sprites.cjs), `frameCount` cells wide. */
export const ROBOT_STRIP_SRC: Record<RobotAnimationName, string> = {
  idle: idleStrip,
  thinking: thinkingStrip,
  talking: talkingStrip,
  sleeping: sleepingStrip,
  searching: searchingStrip,
  working: workingStrip,
  'turn-to-user': turnToUserStrip,
  'facing-user': facingUserStrip,
  dragging: draggingStrip,
  'drop-landing': dropLandingStrip,
  appearing: appearingStrip,
  disappearing: disappearingStrip,
};

/** Reduced motion: how long appearing/disappearing fade instead of playing. */
export const FADE_MS = 160;
// ponytail: 8 of 12 strips stay decoded per renderer; raise it if robots visibly reload strips they just used.
const MAX_CACHED_STRIPS = 8;

export type StripLoader = (src: string) => { ready: Promise<void>; dispose: () => void };

/**
 * Decoded sprite strips, shared by everything in this renderer and keyed by strip only (never by agent): a
 * least-recently-used map that never evicts a strip someone is showing. Each widget window is its own renderer
 * process, so strips are shared across widgets through Chromium's resource cache, not this map.
 */
export class StripCache {
  private readonly entries = new Map<
    string,
    { ready: Promise<void>; loaded: boolean; refs: number; dispose: () => void }
  >();

  constructor(
    private readonly loader: StripLoader,
    private readonly max = MAX_CACHED_STRIPS
  ) {}

  /** Start (or reuse) decoding a strip; resolves once it can be drawn without a blank frame. */
  load(src: string): Promise<void> {
    const existing = this.entries.get(src);
    if (existing) {
      // Re-insert: Map order is the recency order.
      this.entries.delete(src);
      this.entries.set(src, existing);
      return existing.ready;
    }
    const { ready, dispose } = this.loader(src);
    const entry = { ready: Promise.resolve(), loaded: false, refs: 0, dispose };
    entry.ready = ready.then(
      () => {
        entry.loaded = true;
      },
      (error: unknown) => {
        // A failed decode is forgotten so the next request retries it.
        if (this.entries.get(src) === entry) this.entries.delete(src);
        throw error;
      }
    );
    this.entries.set(src, entry);
    this.evict();
    return entry.ready;
  }

  isReady(src: string): boolean {
    return this.entries.get(src)?.loaded ?? false;
  }

  retain(src: string): void {
    const entry = this.entries.get(src);
    if (entry) entry.refs += 1;
  }

  release(src: string): void {
    const entry = this.entries.get(src);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    this.evict();
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(): void {
    for (const [src, entry] of this.entries) {
      if (this.entries.size <= this.max) return;
      if (entry.refs > 0) continue;
      entry.dispose();
      this.entries.delete(src);
    }
  }
}

const loadImage: StripLoader = (src) => {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  const ready =
    typeof image.decode === 'function'
      ? image.decode()
      : new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = reject;
        });
  return { ready, dispose: () => image.removeAttribute('src') };
};

export const stripCache = new StripCache(loadImage);

/** Decode these clips' strips now (the essential ones before showing the window, likely-next ones after). */
export function preloadRobotStrips(strips: RobotStrip[]): Promise<void> {
  return Promise.all(strips.map((strip) => stripCache.load(ROBOT_STRIP_SRC[ROBOT_CLIPS[strip].asset]))).then(
    (): void => undefined
  );
}

type Shown = {
  strip: RobotStrip;
  src: string;
  startedAt: number;
  /** Restarts the clip's timing when it changes (a held pose starts playing, a fade begins, a new turn). */
  restartKey: string;
  frame: number;
  size: number;
  ended: boolean;
};

const restartKeyOf = (v: RobotVisual) => `${v.frame === null ? 'play' : 'hold'}|${v.fade ?? ''}|${v.turn?.since ?? ''}`;

/**
 * The widget's single animation clock: one requestAnimationFrame loop that draws the frame for the elapsed time
 * (never an ever-incrementing counter), switches strips only once the next one is decoded (the previous frame
 * stays up meanwhile), reports finished one-shots, and stops while the window is hidden or unmounted.
 */
function useRobotClock(
  ref: React.RefObject<HTMLDivElement | null>,
  visual: RobotVisual,
  size: number,
  reduceMotion: boolean,
  onClipEnd: ((strip: RobotStrip) => void) | undefined
): void {
  const latest = useRef({ visual, size, reduceMotion, onClipEnd });
  latest.current = { visual, size, reduceMotion, onClipEnd };

  useEffect(() => {
    let raf = 0;
    let shown: Shown | null = null;
    let wanted: string | null = null;
    let alive = true;

    const schedule = () => {
      if (alive && !raf && document.visibilityState !== 'hidden') raf = requestAnimationFrame(tick);
    };

    const switchTo = (el: HTMLDivElement, v: RobotVisual, src: string, now: number) => {
      if (shown) stripCache.release(shown.src);
      stripCache.retain(src);
      shown = { strip: v.strip, src, startedAt: now, restartKey: restartKeyOf(v), frame: -1, size: 0, ended: false };
      el.style.backgroundImage = `url(${src})`;
      // Reduced motion: pose changes crossfade instead of cutting.
      if (latest.current.reduceMotion) el.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: FADE_MS });
    };

    function tick(now: number) {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const { visual: v, size: px, onClipEnd: onEnd } = latest.current;
      const src = ROBOT_STRIP_SRC[ROBOT_CLIPS[v.strip].asset];
      if (!shown || shown.strip !== v.strip) {
        if (stripCache.isReady(src)) {
          switchTo(el, v, src, now);
        } else if (wanted !== src) {
          // A newer request supersedes this one: its result is ignored once `wanted` moves on.
          wanted = src;
          stripCache.load(src).then(
            () => {
              if (wanted === src) schedule();
            },
            () => {
              if (wanted === src) wanted = null;
            }
          );
        }
      }
      const current = shown as Shown | null;
      if (current) {
        const clip = ROBOT_CLIPS[current.strip];
        // While the next strip loads, the previous clip keeps playing on its own timeline.
        const active = current.strip === v.strip ? v : null;
        if (active && restartKeyOf(active) !== current.restartKey) {
          current.restartKey = restartKeyOf(active);
          current.startedAt = now;
          current.ended = false;
        }
        const elapsed = now - current.startedAt;
        let frame = clipFrameAt(clip, elapsed);
        if (active?.frame != null) frame = active.frame;
        else if (active?.turn) frame = turnFrameAt(active.turn, now);
        if (px !== current.size) {
          el.style.backgroundSize = `${clip.frameCount * px}px ${px}px`;
          current.size = px;
          current.frame = -1;
        }
        if (frame !== current.frame) {
          el.style.backgroundPositionX = `${-frame * px}px`;
          current.frame = frame;
        }
        if (active && !current.ended) {
          let done = false;
          if (active.turn) done = now >= turnEndsAt(active.turn);
          else if (active.fade) done = elapsed >= FADE_MS;
          else if (active.frame === null) done = clipDone(clip, elapsed);
          if (done) {
            current.ended = true;
            onEnd?.(active.strip);
          }
        }
      }
      schedule();
    }

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        cancelAnimationFrame(raf);
        raf = 0;
      } else schedule();
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      const last = shown as Shown | null;
      if (last) stripCache.release(last.src);
      wanted = null;
    };
  }, [ref]);
}

type RobotSpriteProps = {
  visual: RobotVisual;
  /** Runtime state, for the CSS treatments (listening ring, error tint, offline grey). */
  state: AgentAnimationState;
  size: number;
  reduceMotion: boolean;
  /** The bot's `#rrggbb` color: a still underglow behind the robot. Nothing is drawn without a valid one. */
  glowColor?: string;
  /** A one-shot (turn, lifecycle, landing) finished playing. */
  onClipEnd?: (strip: RobotStrip) => void;
};

/**
 * Three nested layers so their transforms never overwrite each other: direction (mirror), hop (lift + squash,
 * anchored at the feet), sprite (frame strip, drawn by the clock). Nothing else — text, badges, the popup — lives
 * inside the mirror.
 */
const RobotSprite: React.FC<RobotSpriteProps> = ({ visual, state, size, reduceMotion, glowColor, onClipEnd }) => {
  const spriteRef = useRef<HTMLDivElement>(null);
  useRobotClock(spriteRef, visual, size, reduceMotion, onClipEnd);
  return (
    <div
      aria-hidden
      className={classNames(styles.direction, visual.panicking && styles.panicking)}
      data-facing={visual.mirrored ? 'left' : 'right'}
    >
      {isBotColor(glowColor) && (
        <span
          aria-hidden
          data-robot-glow
          className={styles.glow}
          style={{ '--bot-glow': glowColor } as React.CSSProperties}
        />
      )}
      <div className={classNames(styles.hop, visual.hopping && styles.hopping)}>
        <div
          ref={spriteRef}
          data-state={state}
          data-strip={visual.strip}
          className={classNames(
            styles.robot,
            reduceMotion && styles.still,
            visual.fade === 'in' && styles.fadeIn,
            visual.fade === 'out' && styles.fadeOut
          )}
          style={{ '--robot-size': `${size}px` } as React.CSSProperties}
        />
      </div>
    </div>
  );
};

export default RobotSprite;
