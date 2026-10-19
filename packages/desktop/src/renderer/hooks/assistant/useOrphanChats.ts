/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Once per app start, in the main window, looks in the background for chats left behind by VA Bots that were deleted
 * before bot-delete cleaned up after itself, and lets the user delete or keep them. Nothing is removed unasked.
 */

import { configService } from '@/common/config/configService';
import type { TChatConversation } from '@/common/config/storage';
import { findOrphanChats, removeChats } from '@/renderer/hooks/assistant/botChats';
import { getWidgetConversationId } from '@/renderer/pages/agentWidget/chatLocation';
import { emitter } from '@/renderer/utils/emitter';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMatch, useNavigate } from 'react-router-dom';

/** Lets the app finish starting before the (possibly long) search for archived chats begins. */
export const ORPHAN_CHECK_DELAY_MS = 5000;

const KEPT_KEY = 'agent.keptOrphanChats';

let checked = false;

/** Forgets that the check already ran, so a test can run it again. */
export const resetOrphanCheck = (): void => {
  checked = false;
};

export type OrphanChats = {
  orphans: readonly TChatConversation[];
  deleting: boolean;
  progress: { done: number; total: number } | null;
  /** Remember these chats so they are never offered again. */
  keep: () => Promise<void>;
  /** Delete them; resolves with how many failed, out of how many were tried. */
  remove: () => Promise<{ failed: number; total: number }>;
};

export function useOrphanChats(): OrphanChats {
  const navigate = useNavigate();
  const openChatId = useMatch('/conversation/:id')?.params.id;
  const openChatRef = useRef(openChatId);
  openChatRef.current = openChatId;

  const [orphans, setOrphans] = useState<readonly TChatConversation[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [progress, setProgress] = useState<OrphanChats['progress']>(null);

  useEffect(() => {
    if (checked || getWidgetConversationId() !== null) return undefined;
    const timer = setTimeout(() => {
      if (checked) return;
      checked = true;
      // The kept list lives in the settings cache, which may still be loading.
      configService
        .whenReady()
        .then(() => findOrphanChats(configService.get(KEPT_KEY) ?? []))
        .then(setOrphans)
        .catch((error: unknown) => console.warn('[orphanChats] could not look for leftover chats:', error));
    }, ORPHAN_CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const keep = useCallback(async () => {
    const ids = orphans.map((conversation) => conversation.id);
    setOrphans([]);
    try {
      await configService.whenReady();
      await configService.set(KEPT_KEY, [...new Set([...(configService.get(KEPT_KEY) ?? []), ...ids])]);
    } catch (error) {
      console.warn('[orphanChats] could not remember the kept chats:', error);
    }
  }, [orphans]);

  const remove = useCallback(async () => {
    const targets = orphans;
    setDeleting(true);
    try {
      const { failed } = await removeChats(targets, {
        onProgress: (done, total) => setProgress({ done, total }),
        onRemoved: (id) => {
          if (id === openChatRef.current) void navigate('/');
        },
      });
      emitter.emit('chat.history.refresh');
      setOrphans(targets.filter((conversation) => failed.includes(conversation.id)));
      return { failed: failed.length, total: targets.length };
    } finally {
      setDeleting(false);
      setProgress(null);
    }
  }, [orphans, navigate]);

  return { orphans, deleting, progress, keep, remove };
}
