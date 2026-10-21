/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';
import { ipcBridge } from '@/common';
import type { AgentChatLocation } from '@/common/types/agent/agentWidget';
import { requestConversationSendBoxPrefill, takeSendBoxDraftText } from '@/renderer/hooks/chat/useSendBoxDraft';
import { isElectronDesktop } from '@/renderer/utils/platform';

/**
 * Which window currently owns a conversation's interactive chat. The main
 * process is the source of truth; every window mirrors it here. Only one
 * window mounts a send box for a conversation at a time, so exactly one text
 * input can own keyboard focus, and the unsent draft travels with the chat.
 */

const WIDGET_HASH_PREFIX = '#/widget/';

/** The conversation this window is a floating widget for, or null in the main window. */
export function getWidgetConversationId(hash: string = window.location.hash): string | null {
  if (!hash.startsWith(WIDGET_HASH_PREFIX)) return null;
  const id = hash.slice(WIDGET_HASH_PREFIX.length).split(/[/?]/)[0];
  return id ? decodeURIComponent(id) : null;
}

const locations = new Map<string, AgentChatLocation>();
const listeners = new Set<() => void>();
let started = false;

const getLocation = (id: string): AgentChatLocation => locations.get(id) ?? 'main';

function setLocation(id: string, location: AgentChatLocation): void {
  if (getLocation(id) === location) return;
  if (location === 'widget') locations.set(id, location);
  else locations.delete(id);
  listeners.forEach((listener) => listener());
}

function start(): void {
  if (started || !isElectronDesktop()) return;
  started = true;
  const myRole: AgentChatLocation = getWidgetConversationId() ? 'widget' : 'main';
  // A widget window only cares about its own conversation; the main window about all of them. Read the hash
  // each time: a robot that moves to another conversation of its VA Bot keeps the page and changes the hash.
  const concernsMe = (id: string) => myRole === 'main' || id === getWidgetConversationId();

  ipcBridge.agentWidget.chatLocationChanged.on(({ conversation_id, location }) => {
    if (!concernsMe(conversation_id)) return;
    const lostChat = getLocation(conversation_id) === myRole && location !== myRole;
    setLocation(conversation_id, location);
    if (!lostChat) return;
    // Hand the unsent draft to the window that now owns the chat; the text never rides an event payload.
    const text = takeSendBoxDraftText(conversation_id);
    if (text) void ipcBridge.agentWidget.handoffDraft.invoke({ conversation_id, text }).catch(() => {});
  });

  ipcBridge.agentWidget.draftReady.on(({ conversation_id, to }) => {
    if (to !== myRole || !concernsMe(conversation_id)) return;
    void ipcBridge.agentWidget.takeDraft
      .invoke({ conversation_id })
      .then((text) => {
        // Queued until the receiving send box mounts.
        if (text) requestConversationSendBoxPrefill(conversation_id, text);
      })
      .catch(() => {});
  });

  void ipcBridge.agentWidget.getChatLocations
    .invoke()
    .then((record) => {
      for (const [id, location] of Object.entries(record ?? {})) if (concernsMe(id)) setLocation(id, location);
    })
    .catch(() => {});
}

const subscribe = (listener: () => void) => {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Where the conversation's chat is mounted right now; always 'main' outside the desktop app. */
export function useChatLocation(conversationId: string | undefined): AgentChatLocation {
  return useSyncExternalStore(subscribe, () => (conversationId ? getLocation(conversationId) : 'main'));
}

/** Whether the conversation's chat is in its robot's popup right now (main window: any conversation). */
export function isChatInWidget(conversationId: string): boolean {
  start();
  return getLocation(conversationId) === 'widget';
}
