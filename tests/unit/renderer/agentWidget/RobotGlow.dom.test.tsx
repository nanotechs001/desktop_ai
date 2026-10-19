/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The soft underglow under the floating robot: a CSS layer in the bot's color, still (never pulsing).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));

import RobotSprite from '@renderer/pages/agentWidget/RobotSprite';
import type { RobotVisual } from '@renderer/pages/agentWidget/agentAnimationState';

afterEach(cleanup);

const visual: RobotVisual = { strip: 'idle', frame: null, mirrored: false, hopping: false, panicking: false };

const mount = (glowColor?: string, reduceMotion = false) =>
  render(<RobotSprite visual={visual} state='idle' size={88} reduceMotion={reduceMotion} glowColor={glowColor} />)
    .container;

const glowOf = (root: HTMLElement) => root.querySelector<HTMLElement>('[data-robot-glow]');

describe('robot underglow', () => {
  it('draws a glow layer carrying the bot color, behind the robot', () => {
    const root = mount('#3e63dd');
    const glow = glowOf(root)!;
    expect(glow.style.getPropertyValue('--bot-glow')).toBe('#3e63dd');
    expect(glow).toHaveAttribute('aria-hidden', 'true');
    const layers = Array.from(glow.parentElement!.children);
    expect(layers.indexOf(glow)).toBeLessThan(layers.indexOf(root.querySelector('[data-strip]')!.parentElement!));
  });

  it('draws nothing without a bot color or with a value that is not #rrggbb', () => {
    expect(glowOf(mount())).toBeNull();
    cleanup();
    expect(glowOf(mount('red;'))).toBeNull();
    cleanup();
    expect(glowOf(mount('url(x)'))).toBeNull();
  });

  it('is the same still layer when motion is reduced', () => {
    expect(glowOf(mount('#3e63dd', true))).not.toBeNull();
  });

  it('never animates: the glow rule has no animation or transition', () => {
    const css = readFileSync(
      path.resolve(__dirname, '../../../../packages/desktop/src/renderer/pages/agentWidget/RobotSprite.module.css'),
      'utf8'
    );
    const rule = css.match(/\.glow\s*{[^}]*}/)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toContain('radial-gradient');
    expect(rule).not.toMatch(/animation|transition/);
  });
});
