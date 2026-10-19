/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { previewVaBotDelete, type DeletePreview } from './deleteVaBot';

export type DeletePreviewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; preview: DeletePreview };

/**
 * What deleting the bot would take, counted afresh each time the dialog opens for a bot, and again when a delete
 * (`busy`) stops without closing it: a failed delete leaves fewer chats than the last count.
 */
export function useDeletePreview(agentId: string | undefined, open: boolean, busy = false): DeletePreviewState {
  const [state, setState] = useState<DeletePreviewState>({ status: 'loading' });
  const [recounts, setRecounts] = useState(0);
  const wasBusy = useRef(false);

  useEffect(() => {
    if (wasBusy.current && !busy) setRecounts((count) => count + 1);
    wasBusy.current = busy;
  }, [busy]);

  useEffect(() => {
    // Back to loading first, so a reopened dialog never shows the last count.
    setState({ status: 'loading' });
    if (!open || !agentId) return;
    let stale = false;
    previewVaBotDelete(agentId)
      .then((preview) => !stale && setState({ status: 'ready', preview }))
      .catch((error: unknown) => {
        console.warn('[DeleteAssistantModal] could not count what the Agent owns:', error);
        if (!stale) setState({ status: 'error' });
      });
    return () => {
      stale = true;
    };
  }, [agentId, open, recounts]);

  return state;
}
