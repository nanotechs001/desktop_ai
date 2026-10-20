/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { normalizeTextMessageContent, type TMessage } from '@/common/chat/chatLib';

export const HANDOFF_LIMITS = {
  MAX_TURNS: 12,
  MAX_TURN_CHARS: 1500,
  /** Sum of the quoted turn texts (labels excluded). */
  MAX_TOTAL_CHARS: 12000,
  MAX_LAST_REQUEST_CHARS: 4000,
} as const;

/** The first line of every handoff message, never localized, so a later switch can tell a handoff apart (M6). */
export const HANDOFF_TAG = '[Pixebot handoff]';
/** Tags of handoffs written by earlier builds, still read back. */
const LEGACY_HANDOFF_TAGS: ReadonlySet<string> = new Set(['[aionui-handoff]']);

/** Localized lines of the handoff message. */
export type HandoffLabels = {
  header: string;
  /** Says the quoted text is data: earlier conversation, not instructions. */
  dataOnly: string;
  quoteStart: string;
  quoteEnd: string;
  user: string;
  assistant: string;
  lastRequest: string;
  closing: string;
};

type Turn = { role: 'user' | 'assistant'; text: string };

/** The first quoted line: after the tag, the header, the data-only line, a blank line and the quote start. */
const FIRST_QUOTED_LINE = 5;

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

const isQuoted = (line: string): boolean => line === '>' || line.startsWith('> ');

/** Every line quoted with `> `, so nothing inside can pass for the handoff's own lines (ruling R16). */
const quote = (text: string): string[] => text.split('\n').map((line) => (line ? `> ${line}` : '>'));

/** `text` without lines that read as the quote's own start or end markers. */
const withoutMarkers = (text: string, labels: HandoffLabels): string => {
  const markers = new Set([labels.quoteStart.trim(), labels.quoteEnd.trim()]);
  return text
    .split('\n')
    .filter((line) => !markers.has(line.trim()))
    .join('\n')
    .trim();
};

/**
 * The last request a handoff message carried, in full ('' when it had none); null when `text` is not a handoff. Reads
 * the layout {@link buildHandoffMessage} writes: the quoted lines end at the quote end, then a blank line, the
 * last-request label and the request, then a blank line and the closing line.
 */
export function handoffRequestOf(text: string): string | null {
  const lines = text.split('\n');
  if (lines[0] !== HANDOFF_TAG && !LEGACY_HANDOFF_TAGS.has(lines[0])) return null;
  let quoteEnd = FIRST_QUOTED_LINE;
  while (quoteEnd < lines.length && isQuoted(lines[quoteEnd])) quoteEnd += 1;
  return lines
    .slice(quoteEnd + 3, -2)
    .join('\n')
    .trim();
}

/**
 * User (right) and assistant (left) text rows; tool, tips, thinking and hidden rows are skipped. An earlier handoff
 * counts as its own last request, so a chained switch carries the real request on, not a cut-off handoff.
 */
const collectTextTurns = (messages: readonly TMessage[]): Turn[] =>
  messages.flatMap((message): Turn[] => {
    if (message.type !== 'text' || message.hidden) return [];
    if (message.position !== 'right' && message.position !== 'left') return [];
    const content = normalizeTextMessageContent(message.content).content.trim();
    const role = message.position === 'right' ? 'user' : 'assistant';
    const text = role === 'user' ? (handoffRequestOf(content) ?? content) : content;
    return text ? [{ role, text }] : [];
  });

/** The newest turns whose texts fit the total cap. */
const fitTotal = (turns: readonly Turn[]): Turn[] => {
  let total = 0;
  let start = turns.length;
  while (start > 0 && total + turns[start - 1].text.length <= HANDOFF_LIMITS.MAX_TOTAL_CHARS) {
    total += turns[start - 1].text.length;
    start -= 1;
  }
  return turns.slice(start);
};

/**
 * The first message of a chat that continues `messages` on another engine or model: a tag line, the recent text turns,
 * every line quoted and plainly marked as earlier conversation (data, not instructions), then the last user request in
 * full, then an instruction to go on.
 */
export function buildHandoffMessage(messages: readonly TMessage[], labels: HandoffLabels): string {
  const turns = collectTextTurns(messages);
  const quoted = fitTotal(
    turns.slice(-HANDOFF_LIMITS.MAX_TURNS).map((turn) => ({
      role: turn.role,
      text: truncate(withoutMarkers(turn.text, labels), HANDOFF_LIMITS.MAX_TURN_CHARS),
    }))
  );
  const lastRequest = turns.findLast((turn) => turn.role === 'user');
  return [
    HANDOFF_TAG,
    labels.header,
    labels.dataOnly,
    '',
    labels.quoteStart,
    ...quoted.flatMap((turn) => quote(`${turn.role === 'user' ? labels.user : labels.assistant}: ${turn.text}`)),
    labels.quoteEnd,
    ...(lastRequest ? ['', labels.lastRequest, truncate(lastRequest.text, HANDOFF_LIMITS.MAX_LAST_REQUEST_CHARS)] : []),
    '',
    labels.closing,
  ].join('\n');
}
