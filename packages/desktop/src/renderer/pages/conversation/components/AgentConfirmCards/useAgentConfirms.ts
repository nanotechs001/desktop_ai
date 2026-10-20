/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { ConfirmRequest } from '@/common/types/browser';
import type { ConfirmAsk } from './ConfirmBody';

const CONFIRMS_URL = '/api/browser-view/confirms';
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const POLL_MS = 3000;

/** Answers an ask over IPC. Main ignores a second answer, so a reply that lost the race needs no feedback. */
export const replyOverIpc = (id: string, allow: boolean, alwaysForSite: boolean): void => {
  void ipcBridge.agentBrowser.replyConfirm.invoke({ id, allow, alwaysForSite }).catch((): void => undefined);
};

/** Every open ask, from main's full-list events (desktop only). Off when `enabled` is false. */
export const useIpcConfirms = (enabled = true): ConfirmRequest[] => {
  const [open, setOpen] = useState<ConfirmRequest[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let gotEvent = false;
    const off = ipcBridge.agentBrowser.confirmRequested.on((next) => {
      gotEvent = true;
      setOpen(next);
    });
    // An ask raised before mount is still open; an event that arrived first is newer, so it wins.
    void ipcBridge.agentBrowser.getConfirmRequests.invoke().then((res) => {
      if (res.success && res.data && !gotEvent) setOpen(res.data);
    });
    return off;
  }, [enabled]);

  return open;
};

const parseAsk = (value: unknown): ConfirmAsk | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { id, origin, frameOrigin, label } = value as Record<string, unknown>;
  const frameOk = frameOrigin === null || typeof frameOrigin === 'string';
  if (typeof id !== 'string' || typeof origin !== 'string' || typeof label !== 'string' || !frameOk) return null;
  return { id, origin, frameOrigin: frameOrigin as string | null, label };
};

const parseAsks = (body: unknown): ConfirmAsk[] => {
  const list = typeof body === 'object' && body !== null ? (body as { confirms?: unknown }).confirms : undefined;
  return Array.isArray(list) ? list.map(parseAsk).filter((ask): ask is ConfirmAsk => ask !== null) : [];
};

/**
 * The chat's open asks from web-host (WebUI only), asked for at once and every 3 s while the page is visible, the
 * same way useLiveTabs lists tabs. `answer` posts the reply and drops the card; null `conversationId` turns it off.
 */
export const usePolledConfirms = (
  conversationId: string | null
): { asks: ConfirmAsk[]; answer: (id: string, allow: boolean, always: boolean) => void } => {
  const [asks, setAsks] = useState<ConfirmAsk[]>([]);
  // A poll that left before an answer must not bring its card back.
  const answered = useRef(new Set<string>());

  useEffect(() => {
    setAsks([]);
    if (conversationId === null || !CONVERSATION_ID.test(conversationId)) return;
    let live = true;
    let stopped = false;
    const load = (): void => {
      if (stopped || document.visibilityState === 'hidden') return;
      fetch(`${CONFIRMS_URL}?conversation=${encodeURIComponent(conversationId)}`, { credentials: 'include' })
        .then(async (response) => {
          // Signed out, or a host without the route (headless `--webui`): nothing to answer. Only a missing route is final.
          if (response.status === 401 || response.status === 404) {
            if (response.status === 404) {
              stopped = true;
              clearInterval(timer);
            }
            return [];
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return parseAsks(await response.json());
        })
        .then((next) => {
          if (live) setAsks(next.filter((ask) => !answered.current.has(ask.id)));
        })
        .catch((error: unknown) => console.warn('[AgentConfirmCards] could not list the confirms:', error));
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') load();
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [conversationId]);

  const answer = useCallback((id: string, allow: boolean, always: boolean): void => {
    answered.current.add(id);
    setAsks((current) => current.filter((ask) => ask.id !== id));
    // 404 means another view answered first (or it timed out): the ask is settled either way.
    fetch(`${CONFIRMS_URL}/${encodeURIComponent(id)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow, always }),
    })
      .then((response) => {
        if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
      })
      .catch((error: unknown) => {
        // Not sent: show the ask again on the next poll so the user can retry.
        answered.current.delete(id);
        console.warn('[AgentConfirmCards] could not send the answer:', error);
      });
  }, []);

  return { asks, answer };
};
