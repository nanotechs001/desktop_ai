/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A start or end marker of any managed block: `<!-- aion-<name>:start -->` / `:end -->`. */
const MARKER = /<!-- (aion-[a-z0-9-]+):(start|end) -->/g;

/**
 * Remove the app-managed blocks (`aion-browser-rule`, `aion-notes`, ...) from an Agent's rule so the
 * editor shows only the user's own text. If any block's markers are not exactly one start followed
 * by one end, nothing is removed, so the user can see and repair them.
 */
export function stripBrowserRule(text: string): string {
  const spans = new Map<string, { starts: number[]; ends: number[] }>();
  for (const match of text.matchAll(MARKER)) {
    const entry = spans.get(match[1]) ?? { starts: [], ends: [] };
    (match[2] === 'start' ? entry.starts : entry.ends).push(match.index);
    spans.set(match[1], entry);
  }
  if (spans.size === 0) return text;

  const blocks: Array<[number, number]> = [];
  for (const [name, { starts, ends }] of spans) {
    if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) return text;
    blocks.push([starts[0], ends[0] + `<!-- ${name}:end -->`.length]);
  }

  let cursor = 0;
  const pieces: string[] = [];
  for (const [start, end] of blocks.sort((a, b) => a[0] - b[0])) {
    if (start < cursor) return text; // nested or overlapping blocks are not ours
    pieces.push(text.slice(cursor, start));
    cursor = end;
  }
  pieces.push(text.slice(cursor));
  return pieces
    .map((piece, index) => (index === 0 ? piece.trimEnd() : piece.trim()))
    .filter(Boolean)
    .join('\n\n');
}
