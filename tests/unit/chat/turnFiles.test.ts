/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall, IMessageText, TMessage } from '@/common/chat/chatLib';
import {
  TurnFileAutoOpenTracker,
  groupTurnFiles,
  mapTurnFilesToAnchors,
} from '@/renderer/pages/conversation/Messages/fileLinks/turnFiles';

const NOW = 1_800_000_000_000;

const user = (id: string, created_at = NOW): IMessageText => ({
  id,
  conversation_id: 'c1',
  type: 'text',
  position: 'right',
  created_at,
  content: { content: 'hi' },
});

const write = (
  id: string,
  path: string,
  status: IMessageAcpToolCall['content']['update']['status'],
  created_at = NOW
): IMessageAcpToolCall => ({
  id,
  conversation_id: 'c1',
  type: 'acp_tool_call',
  position: 'left',
  created_at,
  content: {
    sessionId: 's1',
    update: {
      sessionUpdate: 'tool_call_update',
      tool_call_id: id,
      status,
      title: 'Write',
      kind: 'edit',
      rawInput: { file_path: path },
    },
  },
});

describe('groupTurnFiles / mapTurnFilesToAnchors', () => {
  it('groups documents per turn and anchors them after the turn’s last row', () => {
    const messages: TMessage[] = [
      user('u1'),
      write('w1', 'a.md', 'completed'),
      write('w2', 'a.md', 'completed'),
      user('u2'),
      write('w3', 'b.html', 'completed'),
    ];
    const groups = groupTurnFiles(messages);
    expect(groups.map((g) => [g.turnKey, g.files.map((f) => f.name)])).toEqual([
      ['u1', ['a.md']],
      ['u2', ['b.html']],
    ]);

    const anchors = mapTurnFilesToAnchors(
      [
        { anchorId: 'u1', sourceMessageIds: ['u1'] },
        { anchorId: 'w1', sourceMessageIds: ['w1', 'w2'] },
        { anchorId: 'u2', sourceMessageIds: ['u2'] },
        { anchorId: 'w3', sourceMessageIds: ['w3'] },
      ],
      groups
    );
    expect([...anchors.keys()]).toEqual(['w1', 'w3']);
  });
});

describe('TurnFileAutoOpenTracker', () => {
  it('does not open documents loaded from history', () => {
    const tracker = new TurnFileAutoOpenTracker(NOW);
    const history = [user('u1', NOW - 60_000), write('w1', 'a.md', 'completed', NOW - 50_000)];
    expect(tracker.observe([])).toBeUndefined();
    expect(tracker.observe(history)).toBeUndefined();
    expect(tracker.observe([...history])).toBeUndefined();
  });

  it('opens once when a live tool call goes from running to completed', () => {
    const tracker = new TurnFileAutoOpenTracker(NOW);
    // Even with an old timestamp, seeing it unfinished first proves it is live.
    const turn = [user('u1', NOW - 60_000)];
    expect(tracker.observe([...turn, write('w1', 'a.md', 'in_progress', NOW - 50_000)])).toBeUndefined();
    expect(tracker.observe([...turn, write('w1', 'a.md', 'completed', NOW - 50_000)])).toBe('a.md');
    expect(tracker.observe([...turn, write('w1', 'a.md', 'completed', NOW - 50_000)])).toBeUndefined();
  });

  it('opens a call that arrives already completed after the conversation came on screen', () => {
    const tracker = new TurnFileAutoOpenTracker(NOW);
    expect(tracker.observe([user('u1'), write('w1', 'a.pdf', 'completed', NOW + 1000)])).toBe('a.pdf');
  });

  it('opens each file once per turn, and the newest when several finish together', () => {
    const tracker = new TurnFileAutoOpenTracker(NOW);
    const turn: TMessage[] = [
      user('u1'),
      write('w1', 'a.md', 'completed', NOW + 1),
      write('w2', 'b.html', 'completed', NOW + 2),
    ];
    expect(tracker.observe(turn)).toBe('b.html');
    // Editing a.md again in the same turn opens it (first time), editing b.html again does not.
    expect(tracker.observe([...turn, write('w3', 'b.html', 'completed', NOW + 3)])).toBeUndefined();
    expect(
      tracker.observe([...turn, write('w3', 'b.html', 'completed', NOW + 3), write('w4', 'a.md', 'completed', NOW + 4)])
    ).toBe('a.md');
    // A new turn may open b.html again.
    expect(tracker.observe([...turn, user('u2', NOW + 5), write('w5', 'b.html', 'completed', NOW + 6)])).toBe('b.html');
  });

  it('ignores calls in earlier turns', () => {
    const tracker = new TurnFileAutoOpenTracker(NOW);
    expect(tracker.observe([user('u1'), write('w1', 'a.md', 'in_progress'), user('u2')])).toBeUndefined();
    expect(tracker.observe([user('u1'), write('w1', 'a.md', 'completed'), user('u2')])).toBeUndefined();
  });
});
