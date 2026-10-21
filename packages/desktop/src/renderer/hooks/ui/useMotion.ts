/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

/**
 * Durations of the motion tokens in `styles/themes/base.css` (`--motion-fast|base|slow`), for code that must wait
 * for a CSS transition to finish. Keep both in step.
 */
export const MOTION_MS = { fast: 150, base: 240, slow: 320 } as const;

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether UI motion is off: the OS asks for reduced motion, or the app's own "Reduce motion" setting is on
 * (mirrored on `<html data-reduce-motion>` by {@link useMotionPreference}). With no `matchMedia` at all (jsdom),
 * motion counts as off, so tests see every change at once.
 */
export const isMotionReduced = (): boolean => {
  if (typeof document !== 'undefined' && document.documentElement.dataset.reduceMotion === 'true') return true;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(REDUCE_QUERY)?.matches ?? true;
};

/**
 * Mirrors the app's "Reduce motion" setting (`reduce`) on `<html data-reduce-motion>`, which zeroes the motion tokens
 * for the whole window (the OS preference does that through `@media`). Mount once per window: the main layout and
 * each robot window.
 */
export function useMotionPreference(reduce: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    if (reduce) root.dataset.reduceMotion = 'true';
    else delete root.dataset.reduceMotion;
  }, [reduce]);
}

/**
 * True from the moment `value` changes until `ms` later: the window in which a CSS transition driven by that value
 * runs. Lets a closing node stay mounted for its exit (`open || animating`), and turns transition-only styles
 * (`will-change`, a transition that must not lag a drag) on just while they matter. Always false under reduced
 * motion, so the change lands in the same render.
 */
export function useAnimating(value: unknown, ms: number): boolean {
  const [previous, setPrevious] = useState(value);
  const [animating, setAnimating] = useState(false);
  if (!Object.is(previous, value)) {
    setPrevious(value);
    setAnimating(!isMotionReduced());
  }
  useEffect(() => {
    if (!animating) return;
    const timer = window.setTimeout(() => setAnimating(false), ms);
    return () => window.clearTimeout(timer);
    // `previous` restarts the timer when the value flips again mid-animation.
  }, [animating, ms, previous]);
  return animating;
}

/**
 * False on mount and for two frames after `key` changes, then true. Gates a transition so a state that settles right
 * after mounting (a drawer that closes itself on entering the phone layout) snaps instead of sliding on load.
 */
export function useSettledAfter(key: unknown): boolean {
  const [state, setState] = useState({ key, settled: false });
  if (!Object.is(state.key, key)) setState({ key, settled: false });
  useEffect(() => {
    if (state.settled) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() =>
        setState((current) => (Object.is(current.key, key) ? { key, settled: true } : current))
      );
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [key, state.settled]);
  return state.settled && Object.is(state.key, key);
}
