/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from '@/common/chat/chatLib';
import {
  collectTurnFiles,
  extractToolFileTargets,
  getPathKey,
  isFileToolMessage,
  type FileToolMessage,
  type TurnFile,
} from './toolFilePaths';

/** Documents produced in one turn (a turn runs from a user message to the next). */
export type TurnFileGroup = {
  /** Id of the user message that opened the turn; `''` for messages before any. */
  turnKey: string;
  files: TurnFile[];
  /** Ids of every message in the turn, used to find where the chips render. */
  messageIds: Set<string>;
};

/**
 * Split the timeline into turns and collect each turn's unique documents. Turns
 * without documents are omitted.
 */
export const groupTurnFiles = (messages: TMessage[]): TurnFileGroup[] => {
  const groups: TurnFileGroup[] = [];
  let turnKey = '';
  let ids = new Set<string>();
  let tools: FileToolMessage[] = [];

  const flush = () => {
    const files = collectTurnFiles(tools);
    if (files.length > 0) groups.push({ turnKey, files, messageIds: ids });
  };

  for (const message of messages) {
    if (message.hidden) continue;
    if (message.position === 'right') {
      flush();
      turnKey = message.id;
      ids = new Set([message.id]);
      tools = [];
      continue;
    }
    ids.add(message.id);
    if (isFileToolMessage(message)) tools.push(message);
  }
  flush();
  return groups;
};

/** A timeline row as MessageList renders it: its anchor id and the messages it stands for. */
export type TimelineRow = { anchorId: string; sourceMessageIds: string[] };

/**
 * Where each turn's chips render: after the turn's last row in the timeline, so the
 * files sit at the end of the assistant's reply. Returns anchor id → files.
 */
export const mapTurnFilesToAnchors = (rows: TimelineRow[], groups: TurnFileGroup[]): Map<string, TurnFile[]> => {
  const anchors = new Map<string, TurnFile[]>();
  for (const group of groups) {
    let anchorId: string | undefined;
    for (const row of rows) {
      if (row.sourceMessageIds.some((id) => group.messageIds.has(id))) anchorId = row.anchorId;
    }
    if (anchorId) anchors.set(anchorId, [...(anchors.get(anchorId) ?? []), ...group.files]);
  }
  return anchors;
};

/** Message timestamps are epoch ms; tolerate a seconds stamp rather than misreading it as 1970. */
const toEpochMs = (value: number | undefined): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return value < 1e12 ? value * 1000 : value;
};

/**
 * Decides which document — if any — to open automatically as a turn streams.
 *
 * "Live" means the tool call finished while this conversation was on screen, and
 * is established per tool call + path without trusting any loading flag:
 *
 * - the call was first seen unfinished in this session and later seen completed, or
 * - it was first seen already completed and its message was created after the
 *   tracker started (history rows carry their original, earlier timestamps).
 *
 * Only calls in the latest turn qualify, each file opens at most once per turn,
 * and when several qualify in one update the newest wins.
 */
export class TurnFileAutoOpenTracker {
  private readonly pending = new Set<string>();
  private readonly handled = new Set<string>();
  private readonly openedInTurn = new Set<string>();
  private turnKey: string | undefined;

  /**
   * @param since   Epoch ms the conversation came on screen.
   * @param slackMs Tolerance for clock differences between the backend stamp and this window.
   */
  constructor(
    private readonly since: number,
    private readonly slackMs = 2000
  ) {}

  /** Feed the current timeline; returns the path to open now, or undefined. */
  observe(messages: TMessage[]): string | undefined {
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i].hidden && messages[i].position === 'right') {
        lastUserIndex = i;
        break;
      }
    }
    const turnKey = lastUserIndex >= 0 ? messages[lastUserIndex].id : '';
    if (turnKey !== this.turnKey) {
      this.turnKey = turnKey;
      this.openedInTurn.clear();
    }

    let candidate: { path: string; pathKey: string } | undefined;
    for (let i = lastUserIndex + 1; i < messages.length; i++) {
      const message = messages[i];
      if (message.hidden || !isFileToolMessage(message)) continue;
      for (const target of extractToolFileTargets(message)) {
        const pathKey = getPathKey(target.path);
        const key = `${target.toolKey}|${pathKey}`;
        if (this.handled.has(key)) continue;
        if (!target.completed) {
          this.pending.add(key);
          continue;
        }
        this.handled.add(key);
        const live = this.pending.has(key) || toEpochMs(message.created_at) >= this.since - this.slackMs;
        if (live && !this.openedInTurn.has(pathKey)) candidate = { path: target.path, pathKey };
      }
    }

    if (!candidate) return undefined;
    this.openedInTurn.add(candidate.pathKey);
    return candidate.path;
  }
}
