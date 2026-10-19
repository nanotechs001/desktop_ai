/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  assignMissingBotColors,
  BOT_COLOR_PALETTE,
  fallbackBotColor,
  isBotColor,
  pickNewBotColor,
} from '@/common/types/agent/botColors';

/** A deterministic `Math.random` stand-in that replays the given values in a loop. */
const sequence = (...values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length];
};

describe('BOT_COLOR_PALETTE', () => {
  it('has 12 distinct #rrggbb colors', () => {
    expect(BOT_COLOR_PALETTE).toHaveLength(12);
    expect(new Set(BOT_COLOR_PALETTE.map((color) => color.toLowerCase())).size).toBe(12);
    expect(BOT_COLOR_PALETTE.every(isBotColor)).toBe(true);
  });
});

describe('isBotColor', () => {
  it.each(['#aabbcc', '#AABBCC', '#0f0F0f'])('accepts %s', (value) => {
    expect(isBotColor(value)).toBe(true);
  });

  it.each(['#abc', 'aabbcc', '#aabbccdd', '#gggggg', 'red', '', ' #aabbcc', 12, null, undefined, {}])(
    'rejects %j',
    (value) => {
      expect(isBotColor(value)).toBe(false);
    }
  );
});

describe('pickNewBotColor', () => {
  it('returns a palette color that no other bot uses', () => {
    const used = BOT_COLOR_PALETTE.slice(0, 11);
    for (const roll of [0, 0.5, 0.999]) {
      expect(pickNewBotColor(used, () => roll)).toBe(BOT_COLOR_PALETTE[11]);
    }
  });

  it('picks randomly among the unused colors', () => {
    const used = [BOT_COLOR_PALETTE[0]];
    expect(pickNewBotColor(used, () => 0)).toBe(BOT_COLOR_PALETTE[1]);
    expect(pickNewBotColor(used, () => 0.999)).toBe(BOT_COLOR_PALETTE[11]);
  });

  it('compares used colors case-insensitively', () => {
    const used = BOT_COLOR_PALETTE.map((color) => color.toUpperCase()).slice(0, 11);
    expect(pickNewBotColor(used, () => 0)).toBe(BOT_COLOR_PALETTE[11]);
  });

  it('ignores used colors that are not in the palette', () => {
    expect(pickNewBotColor(['#123456', 'nonsense'], () => 0)).toBe(BOT_COLOR_PALETTE[0]);
  });

  it('falls back to any palette color when all of them are used', () => {
    const picked = pickNewBotColor(BOT_COLOR_PALETTE, () => 0.5);
    expect(BOT_COLOR_PALETTE).toContain(picked);
  });

  it('works with the default Math.random', () => {
    expect(BOT_COLOR_PALETTE).toContain(pickNewBotColor([]));
  });
});

describe('fallbackBotColor', () => {
  it('is stable for one id and always a palette color', () => {
    expect(fallbackBotColor('agent-1')).toBe(fallbackBotColor('agent-1'));
    expect(BOT_COLOR_PALETTE).toContain(fallbackBotColor('agent-1'));
    expect(BOT_COLOR_PALETTE).toContain(fallbackBotColor(''));
  });

  it('spreads different ids over several colors', () => {
    const colors = new Set(Array.from({ length: 60 }, (_, index) => fallbackBotColor(`bot-${index}`)));
    expect(colors.size).toBeGreaterThan(5);
  });
});

describe('assignMissingBotColors', () => {
  it('adds a distinct color to each id that has none, in order', () => {
    const next = assignMissingBotColors({}, ['a', 'b', 'c'], sequence(0));
    expect(next).toEqual({
      a: BOT_COLOR_PALETTE[0],
      b: BOT_COLOR_PALETTE[1],
      c: BOT_COLOR_PALETTE[2],
    });
  });

  it('never overwrites an existing color and avoids the colors already used', () => {
    const colors = { a: BOT_COLOR_PALETTE[0] };
    const next = assignMissingBotColors(colors, ['a', 'b'], sequence(0));
    expect(next.a).toBe(BOT_COLOR_PALETTE[0]);
    expect(next.b).toBe(BOT_COLOR_PALETTE[1]);
  });

  it('does not mutate its input', () => {
    const colors = Object.freeze({ a: BOT_COLOR_PALETTE[0] });
    const ids = Object.freeze(['a', 'b']);
    const next = assignMissingBotColors(colors, ids);
    expect(next).not.toBe(colors);
    expect(colors).toEqual({ a: BOT_COLOR_PALETTE[0] });
  });

  it('keeps colors of ids that are no longer listed', () => {
    const next = assignMissingBotColors({ gone: '#123456' }, ['a']);
    expect(next.gone).toBe('#123456');
  });

  it('treats a stored value that is not a color as missing', () => {
    const next = assignMissingBotColors({ a: 'oops' }, ['a'], sequence(0));
    expect(next.a).toBe(BOT_COLOR_PALETTE[0]);
  });

  it('keeps every color distinct while palette colors remain', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `bot-${index}`);
    const next = assignMissingBotColors({}, ids);
    expect(new Set(Object.values(next)).size).toBe(12);
  });

  it('reuses palette colors once all are taken', () => {
    const ids = Array.from({ length: 14 }, (_, index) => `bot-${index}`);
    const next = assignMissingBotColors({}, ids);
    expect(Object.keys(next)).toHaveLength(14);
    expect(Object.values(next).every((color) => BOT_COLOR_PALETTE.includes(color))).toBe(true);
  });

  it('returns an equal map when nothing is missing', () => {
    const colors = { a: BOT_COLOR_PALETTE[3] };
    expect(assignMissingBotColors(colors, ['a'])).toEqual(colors);
  });
});
