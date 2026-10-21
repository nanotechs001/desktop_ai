/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { AgentWidgetRobot, AgentWidgetSettings } from '@/common/types/agent/agentWidget';
import type { TabOwnership } from '@/common/types/browser';
import { DEFAULT_AGENT_SETTING_KEY, isVaBotAgent } from '@/common/types/agent/defaultAgent';
import { configService } from '@/common/config/configService';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import { resolveCronJobId } from '@/renderer/pages/cron/cronUtils';
import { addEventListener } from '@/renderer/utils/emitter';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { getWidgetConversationId } from './chatLocation';

const SETTINGS_KEY = 'agentWidget.settings';

/** Live widget settings (null outside the desktop app or before the first read). */
export function useAgentWidgetSettings(): AgentWidgetSettings | null {
  const supported = isElectronDesktop();
  const { data, mutate } = useSWR(supported ? SETTINGS_KEY : null, () => ipcBridge.agentWidget.getSettings.invoke());
  useEffect(() => {
    if (!supported) return;
    return ipcBridge.agentWidget.settingsChanged.on((next) => void mutate(next, { revalidate: false }));
  }, [supported, mutate]);
  return data ?? null;
}

/**
 * A newly created conversation gets its widget only once its runtime and
 * persisted session are ready — a worker that fails to start never gets a robot.
 * Scheduled (cron) runs and channel conversations are skipped so background
 * jobs don't fill the taskbar.
 */
export async function launchWidgetWhenReady(conversationId: string): Promise<boolean> {
  const settings = await ipcBridge.agentWidget.getSettings.invoke();
  if (!settings.enabled || !settings.autoLaunch) return false;
  const conversation = await getConversationOrNull(conversationId);
  if (!conversation || resolveCronJobId(conversation.extra)) return false;
  // Only VA Bots (user-created Agents) get a taskbar robot; regular chats never do.
  if (!isVaBotAgent(conversation.assistant, configService.get(DEFAULT_AGENT_SETTING_KEY))) return false;
  if (conversation.source && conversation.source !== 'aionui') return false;
  try {
    await ensureConversationRuntime(conversationId);
  } catch {
    return false;
  }
  return ipcBridge.agentWidget.ensure.invoke({ conversation_id: conversationId, agent_id: conversation.assistant?.id });
}

const removeWidget = (conversationId: string): void => {
  void ipcBridge.agentWidget.remove.invoke({ conversation_id: conversationId }).catch(() => {});
};

/** Main window only: follow conversation lifecycle events and create/remove widgets to match. */
export function useAgentWidgetSync(): void {
  useEffect(() => {
    if (!isElectronDesktop() || getWidgetConversationId()) return;
    const offList = ipcBridge.conversation.listChanged.on(({ conversation_id, action }) => {
      if (action === 'created') void launchWidgetWhenReady(conversation_id).catch(() => {});
      else if (action === 'deleted') removeWidget(conversation_id);
    });
    const offDeleted = addEventListener('conversation.deleted', removeWidget);
    const offArchived = addEventListener('conversation.archived', removeWidget);
    return () => {
      offList();
      offDeleted();
      offArchived();
    };
  }, []);
}

/**
 * Main window only: while the user watches a VA Bot's chat here (chat pane open, window visible), its taskbar robot
 * steps away; it comes back when the chat closes, the user switches to another chat or the window is minimized.
 */
export function useSuspendAgentWidget(conversationId: string | undefined, chatOpen: boolean): void {
  const [windowVisible, setWindowVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const onChange = () => setWindowVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  const suspended = Boolean(conversationId) && chatOpen && windowVisible;
  useEffect(() => {
    if (!conversationId || !suspended || !isElectronDesktop() || getWidgetConversationId()) return;
    const set = (value: boolean): void =>
      void ipcBridge.agentWidget.setSuspended
        .invoke({ conversation_id: conversationId, suspended: value })
        .catch(() => {});
    set(true);
    return () => set(false);
  }, [conversationId, suspended]);
}

/** Every robot, on the desktop or hidden (main window only; [] elsewhere), kept current as robots come and go. */
export function useRobots(): AgentWidgetRobot[] {
  const [robots, setRobots] = useState<AgentWidgetRobot[]>([]);
  useEffect(() => {
    if (!isElectronDesktop() || getWidgetConversationId()) return;
    let active = true;
    void ipcBridge.agentWidget.listRobots
      .invoke()
      .then((list) => active && setRobots(list ?? []))
      .catch(() => {});
    const off = ipcBridge.agentWidget.robotsChanged.on((list) => setRobots(list ?? []));
    return () => {
      active = false;
      off();
    };
  }, []);
  return robots;
}

/**
 * Chatting with a VA Bot in the main window brings back its robot if the user had hidden it (the robot still steps
 * aside while this chat is open, see useSuspendAgentWidget). Bots that never had a robot are left alone.
 */
export function useRestoreHiddenAgentWidget(conversationId: string | undefined, agentId: string | undefined): void {
  useEffect(() => {
    if (!conversationId || !isElectronDesktop() || getWidgetConversationId()) return;
    void ipcBridge.agentWidget.listHidden
      .invoke()
      .then((list) => {
        const hiddenHere = (list ?? []).some(
          (robot) => robot.conversation_id === conversationId || (agentId && robot.agent_id === agentId)
        );
        if (!hiddenHere) return;
        return ipcBridge.agentWidget.ensure.invoke({ conversation_id: conversationId, force: true, agent_id: agentId });
      })
      .catch(() => {});
  }, [conversationId, agentId]);
}

type FollowRobotChatDeps = {
  revealBrowserFor: (conversationId: string) => void;
  navigate: (path: string) => void;
};

/**
 * A robot's popup moved to chat `to` (opened, a new chat, one from its history). The main window follows with that
 * chat's browser pane, but only while it shows a VA Bot chat: elsewhere (a plain chat, settings) it stays put.
 */
export async function followRobotChat(pathname: string, to: string, deps: FollowRobotChatDeps): Promise<boolean> {
  const onScreen = /^\/conversation\/([^/?#]+)/.exec(pathname)?.[1];
  if (!onScreen || onScreen === to) return false;
  const current = await getConversationOrNull(onScreen);
  if (!current || !isVaBotAgent(current.assistant, configService.get(DEFAULT_AGENT_SETTING_KEY))) return false;
  deps.revealBrowserFor(to);
  deps.navigate(`/conversation/${to}`);
  return true;
}

/** Agent actions on a tab that put another page in front of the user. */
const ACTIVITY_OPS = new Set(['open', 'switch', 'navigate']);

/**
 * Calls `listener` with the chat and page each time an agent opens, switches to or navigates a browser tab (main's open
 * request and action report; a tab's chat comes from relay ownership). Returns the unsubscribe.
 */
export function onAgentTabActivity(listener: (conversationId: string, url: string) => void): () => void {
  let alive = true;
  let chatOfTab = new Map<number, string | undefined>();
  let gotOwnership = false;
  const setOwnership = (list: TabOwnership[]) => {
    chatOfTab = new Map(
      list.map((entry) => [entry.webContentsId, entry.owner === 'user' ? undefined : entry.owner.conversationId])
    );
  };
  const offOwnership = ipcBridge.agentBrowser.ownershipChanged.on((list) => {
    gotOwnership = true;
    setOwnership(list);
  });
  void ipcBridge.agentBrowser.getOwnership
    .invoke()
    .then((res) => {
      if (alive && !gotOwnership && res.success && res.data) setOwnership(res.data);
    })
    .catch((error: unknown) => console.warn('[agentWidget] could not read tab ownership:', error));
  const offAction = ipcBridge.agentBrowser.agentAction.on((event) => {
    const chat = chatOfTab.get(event.webContentsId);
    if (chat && ACTIVITY_OPS.has(event.op)) listener(chat, event.label);
  });
  const offOpen = ipcBridge.browser.openTabRequested.on((request) => {
    if (request.conversationId && !request.background) listener(request.conversationId, request.url);
  });
  return () => {
    alive = false;
    offOwnership();
    offAction();
    offOpen();
  };
}
