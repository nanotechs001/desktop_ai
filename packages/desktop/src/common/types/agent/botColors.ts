/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every VA Bot has a color shown as a small dot next to its name. The colors live in the client setting
 * `agent.colors` (assistant id -> `#rrggbb`); these helpers are pure so main, renderer and tests share them.
 */

/** Twelve distinct hues at mid saturation and lightness, legible as a dot on light and dark backgrounds. */
export const BOT_COLOR_PALETTE: readonly string[] = [
  '#e5484d', // red
  '#f76b15', // orange
  '#e0a400', // amber
  '#8cb82d', // lime
  '#30a46c', // green
  '#12a594', // teal
  '#0d9bd8', // sky
  '#3e63dd', // blue
  '#6e56cf', // violet
  '#ab4aba', // purple
  '#d6409f', // pink
  '#8b7355', // clay
];

const BOT_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

export const isBotColor = (value: unknown): value is string =>
  typeof value === 'string' && BOT_COLOR_PATTERN.test(value);

const pickFrom = (choices: readonly string[], random: () => number): string =>
  choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];

/** A random palette color no other bot uses; any random palette color once all of them are taken. */
export function pickNewBotColor(used: readonly string[], random: () => number = Math.random): string {
  const taken = new Set(used.map((color) => color.toLowerCase()));
  const free = BOT_COLOR_PALETTE.filter((color) => !taken.has(color));
  return pickFrom(free.length > 0 ? free : BOT_COLOR_PALETTE, random);
}

/** The color shown for a bot with no stored one: a stable hash of its id, so a dot never disappears. */
export function fallbackBotColor(agentId: string): string {
  let hash = 0;
  for (const char of agentId) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  return BOT_COLOR_PALETTE[hash % BOT_COLOR_PALETTE.length];
}

/**
 * A new map with a color added for each id that has none (a stored value that is not a color counts as none), in
 * order and each distinct while palette colors remain. Existing colors are never touched.
 */
export function assignMissingBotColors(
  colors: Readonly<Record<string, string>>,
  agentIds: readonly string[],
  random: () => number = Math.random
): Record<string, string> {
  const next: Record<string, string> = { ...colors };
  for (const id of agentIds) {
    if (!isBotColor(next[id])) next[id] = pickNewBotColor(Object.values(next).filter(isBotColor), random);
  }
  return next;
}
