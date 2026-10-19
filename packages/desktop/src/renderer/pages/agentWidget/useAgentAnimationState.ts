/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { AgentAnimationState } from '@/common/types/agent/agentWidget';
import { addEventListener } from '@/renderer/utils/emitter';
import {
  applyStreamFrame,
  applyTurnCompleted,
  advanceRestCycle,
  createActivity,
  NORMAL_PRESENTATION,
  presentationAdvance,
  presentationOnChatChange,
  resolveAnimationState,
  type AgentActivity,
  type Presentation,
  type RestCycle,
} from './agentAnimationState';

// Re-evaluates time-based transitions (talking → thinking, error hold, sleep) without per-frame work.
const RECHECK_MS = 1000;

/**
 * Robot animation for one conversation, driven by the same backend stream the
 * chat renders from — the widget subscribes, it never opens a second stream.
 */
export type AgentAnimationView = {
  state: AgentAnimationState;
  /** A permission request or question is waiting for the user's answer. */
  awaitingUser: boolean;
  /** The user handled the robot (drag): it counts as activity, so a sleeping robot wakes up. */
  wake: () => void;
};

export function useAgentAnimationState(conversationId: string, chatVisible: boolean): AgentAnimationView {
  const activityRef = useRef<AgentActivity>(createActivity(Date.now()));
  // The idle robot's own nap-and-wake rhythm, so it never sleeps until the next chat.
  const restRef = useRef<RestCycle | null>(null);
  const chatVisibleRef = useRef(chatVisible);
  chatVisibleRef.current = chatVisible;
  const [state, setState] = useState<AgentAnimationState>('idle');
  const [awaitingUser, setAwaitingUser] = useState(false);
  const updateRef = useRef<(fn: (a: AgentActivity) => AgentActivity) => void>(() => {});

  useEffect(() => {
    const recompute = () => {
      const now = Date.now();
      restRef.current = advanceRestCycle(restRef.current, activityRef.current.lastActivityAt, now);
      const next = resolveAnimationState(activityRef.current, now, undefined, restRef.current);
      setState((prev) => (prev === next ? prev : next));
      setAwaitingUser(activityRef.current.awaitingUser);
    };
    const update = (fn: (a: AgentActivity) => AgentActivity) => {
      activityRef.current = fn(activityRef.current);
      recompute();
    };
    updateRef.current = update;

    const offStream = ipcBridge.conversation.responseStream.on((msg) => {
      if (msg.conversation_id === conversationId) update((a) => applyStreamFrame(a, msg, Date.now()));
    });
    const offTurn = ipcBridge.conversation.turnCompleted.on((evt) => {
      if (evt.session_id === conversationId) {
        update((a) => applyTurnCompleted(a, evt, chatVisibleRef.current, Date.now()));
      }
    });
    // The user answered (or the request was withdrawn): stop panicking.
    const offConfirmRemoved = ipcBridge.conversation.confirmation.remove.on((evt) => {
      if (evt.conversation_id === conversationId) update((a) => ({ ...a, awaitingUser: false }));
    });
    const offSpeech = addEventListener('speech.recording', (recording) => {
      update((a) => ({ ...a, micActive: recording, lastActivityAt: Date.now() }));
    });
    // Backend not running (still starting, exited, failed) → the worker is unreachable.
    const backend = window.__backendStartupBridge;
    const setOffline = (failure: unknown) => update((a) => ({ ...a, offline: failure != null }));
    if (backend) setOffline(backend.getState());
    const offBackend = backend?.subscribe(setOffline);
    const timer = window.setInterval(recompute, RECHECK_MS);

    return () => {
      offStream();
      offTurn();
      offConfirmRemoved();
      offSpeech();
      offBackend?.();
      window.clearInterval(timer);
    };
  }, [conversationId]);

  // Opening the chat reads the reply → clear the unread badge.
  useEffect(() => {
    if (!chatVisible || !activityRef.current.unread) return;
    activityRef.current = { ...activityRef.current, unread: false };
    setState(resolveAnimationState(activityRef.current, Date.now(), undefined, restRef.current));
  }, [chatVisible]);

  const wake = useCallback(() => updateRef.current((a) => ({ ...a, lastActivityAt: Date.now() })), []);
  return { state, awaitingUser, wake };
}

/**
 * The robot's presentation pose around the chat popup (turn to the user, face them, turn away). Turns are timed
 * from when they start; the widget's animation clock draws them and calls `advance` when one has played out.
 */
export function useRobotPresentation(chatOpen: boolean, reduceMotion: boolean): [Presentation, () => void] {
  const [presentation, setPresentation] = useState<Presentation>(NORMAL_PRESENTATION);
  useEffect(() => {
    setPresentation((prev) => presentationOnChatChange(prev, chatOpen, reduceMotion, performance.now()));
  }, [chatOpen, reduceMotion]);
  const advance = useCallback(() => setPresentation((prev) => presentationAdvance(prev, performance.now())), []);
  return [presentation, advance];
}
