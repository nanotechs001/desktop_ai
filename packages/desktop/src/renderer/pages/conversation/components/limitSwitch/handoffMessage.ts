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

/** Localized lines of the handoff message. */
export type HandoffLabels = {
  header: string;
  quoteStart: string;
  quoteEnd: string;
  user: string;
  assistant: string;
  lastRequest: string;
  closing: string;
};

type Turn = { role: 'user' | 'assistant'; text: string };

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

/** User (right) and assistant (left) text rows; tool, tips, thinking and hidden rows are skipped. */
const collectTextTurns = (messages: readonly TMessage[]): Turn[] =>
  messages.flatMap((message): Turn[] => {
    if (message.type !== 'text' || message.hidden) return [];
    if (message.position !== 'right' && message.position !== 'left') return [];
    const text = normalizeTextMessageContent(message.content).content.trim();
    return text ? [{ role: message.position === 'right' ? 'user' : 'assistant', text }] : [];
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
 * The first message of a chat that continues `messages` on another engine or model: the recent text turns, quoted
 * and plainly marked as earlier conversation, then the last user request in full, then an instruction to go on.
 */
export function buildHandoffMessage(messages: readonly TMessage[], labels: HandoffLabels): string {
  const turns = collectTextTurns(messages);
  const quoted = fitTotal(
    turns
      .slice(-HANDOFF_LIMITS.MAX_TURNS)
      .map((turn) => ({ role: turn.role, text: truncate(turn.text, HANDOFF_LIMITS.MAX_TURN_CHARS) }))
  );
  const lastRequest = turns.findLast((turn) => turn.role === 'user');
  return [
    labels.header,
    '',
    labels.quoteStart,
    ...quoted.map((turn) => `${turn.role === 'user' ? labels.user : labels.assistant}: ${turn.text}`),
    labels.quoteEnd,
    ...(lastRequest ? ['', labels.lastRequest, truncate(lastRequest.text, HANDOFF_LIMITS.MAX_LAST_REQUEST_CHARS)] : []),
    '',
    labels.closing,
  ].join('\n');
}
