/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from '@/common/chat/chatLib';
import { getWidgetConversationId } from '@/renderer/pages/agentWidget/chatLocation';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { useEffect, useMemo } from 'react';
import { TurnFileAutoOpenTracker } from './turnFiles';
import { useOpenTurnFile } from './useOpenTurnFile';

/**
 * Opens a document in the preview pane when the agent finishes writing it during
 * the live turn of the conversation on screen (see {@link TurnFileAutoOpenTracker}
 * for what counts as live). History loads and conversation switches never open
 * anything: the tracker is recreated per conversation with the switch time as its
 * cut-off.
 *
 * Skipped in VA Bot mode: there the pane is the agent's working browser, and
 * switching it to a document mid-turn would take the page away from the agent and
 * the user. The chips still let the user open the file there. Skipped in a robot window too: it has no pane, and its
 * files open in the main window, which must not be pulled to the chat mid-turn.
 */
export const useAutoOpenTurnFiles = (conversationId: string | undefined, messages: TMessage[]): void => {
  const preview = useOptionalPreviewContext();
  const isVaBotMode = preview?.isVaBotMode === true;
  const openFile = useOpenTurnFile();
  // Recreated per conversation; `conversationId` is the intended dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tracker = useMemo(() => new TurnFileAutoOpenTracker(Date.now()), [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    // Always observe, so calls that finish while auto-open is unavailable are
    // consumed and do not open later.
    const path = tracker.observe(messages);
    if (path && preview && !isVaBotMode && !getWidgetConversationId()) void openFile(path);
  }, [conversationId, isVaBotMode, messages, openFile, preview, tracker]);
};
