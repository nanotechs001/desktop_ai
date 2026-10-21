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

/**
 * `text` (the user's own) followed by the managed blocks stored in `current`, unchanged, for a save that cannot
 * compose them (the WebUI, where main is out of reach).
 */
export function keepManagedBlocks(text: string, current: string): string {
  const blocks = [...current.matchAll(/<!-- (aion-[a-z0-9-]+):start -->[\s\S]*?<!-- \1:end -->/g)].map((m) => m[0]);
  if (blocks.length === 0) return text;
  return `${[text.trim(), ...blocks].filter(Boolean).join('\n\n')}\n`;
}

export type UpsertManagedBlockResult = { ok: true; content: string } | { ok: false; reason: 'unbalanced-markers' };

const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

/**
 * Put the managed block `name` (e.g. `aion-notes`) into an Agent's rule: replace it if present, otherwise append
 * it. A null `body` removes the block. Text outside the markers is never touched. Refuses (ok: false) unless the
 * markers are absent or form exactly one start-then-end pair, so a hand-edited rule can never lose text.
 */
export function upsertManagedBlock(existing: string, name: string, body: string | null): UpsertManagedBlockResult {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const starts = countOf(existing, start);
  const ends = countOf(existing, end);
  const block = body === null ? '' : `${start}\n${body}\n${end}`;
  if (starts === 0 && ends === 0) {
    if (!block) return { ok: true, content: existing };
    const separator = !existing ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    return { ok: true, content: `${existing}${separator}${block}\n` };
  }
  const startAt = existing.indexOf(start);
  const endAt = existing.indexOf(end);
  if (starts !== 1 || ends !== 1 || endAt < startAt) return { ok: false, reason: 'unbalanced-markers' };
  const before = existing.slice(0, startAt);
  const after = existing.slice(endAt + end.length);
  if (block) return { ok: true, content: before + block + after };
  const kept = [before.trimEnd(), after.trim()].filter(Boolean);
  return { ok: true, content: kept.join('\n\n') };
}
