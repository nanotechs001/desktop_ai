/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import type { AgentWidgetLayout, AgentWidgetSettings } from '@/common/types/agent/agentWidget';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { DEFAULT_AGENT_SETTING_KEY, isVaBotAgent } from '@/common/types/agent/defaultAgent';
import { configService } from '@/common/config/configService';
import { VaBotColorDot } from '@/renderer/components/agent/BotColorDot';
import { useBotColorsSync, useVaBotColor } from '@/renderer/hooks/agent/useBotColor';
import { addEventListener } from '@/renderer/utils/emitter';
import { useChatLocation } from './chatLocation';
import { isTurning, resolveRobotVisual, type RobotInteraction, type RobotStrip } from './agentAnimationState';
import RobotSprite, { preloadRobotStrips } from './RobotSprite';
import { useAgentAnimationState, useRobotPresentation } from './useAgentAnimationState';
import WidgetChatPopup from './WidgetChatPopup';
import styles from './AgentWidget.module.css';

// Pointer travel (physical px) before a press on the robot becomes a drag instead of a click.
const DRAG_THRESHOLD_PHYSICAL_PX = 5;
// Decoded before the window is shown (no default-image flash), then the poses the user is likely to see next.
const ESSENTIAL_STRIPS: RobotStrip[] = ['appearing', 'idle'];
const LIKELY_NEXT_STRIPS: RobotStrip[] = ['turn-to-user', 'facing-user', 'dragging', 'drop-landing', 'disappearing'];
// Clicks closer together than this are one click: a transition already being handled is not restarted.
const CLICK_DEBOUNCE_MS = 200;
// Slime-hop height in physical pixels (converted to CSS px for the display's scale).
const HOP_HEIGHT_PHYSICAL_PX = 8;
// Clickable parts of the window. Arco menus, dialogs and toasts render into <body>, outside the popup, so they are
// listed too; otherwise hovering them would make the window click-through and their clicks would reach the desktop.
// The name pill hides this long after the last pointer movement over the robot.
const NAME_HOVER_IDLE_MS = 2000;
const WIDGET_HIT_SELECTOR = '[data-widget-hit], .arco-trigger, .arco-modal-wrapper, .arco-message-wrapper';

/**
 * Floating desktop robot for one conversation (rendered in its own transparent
 * always-on-top window at #/widget/:id). The robot reflects live agent state;
 * clicking it opens the chat popup, dragging slides it along the taskbar.
 */
const AgentWidgetPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const [layout, setLayout] = useState<AgentWidgetLayout | null>(null);
  const [settings, setSettings] = useState<AgentWidgetSettings | null>(null);
  const { data: conversation, isLoading } = useSWR(id ? ['agentWidget.conversation', id] : null, () =>
    getConversationOrNull(id)
  );
  const chatLocation = useChatLocation(id);
  useBotColorsSync();
  const botColor = useVaBotColor(conversation?.assistant);
  const expanded = layout?.expanded ?? false;
  const [chatMounted, setChatMounted] = useState(false);
  const { state, awaitingUser, wake } = useAgentAnimationState(id, expanded && chatLocation === 'widget');
  const reduceMotion = Boolean(settings?.reduceMotion);
  const [presentation, advancePresentation] = useRobotPresentation(expanded, reduceMotion);
  const transitioning = isTurning(presentation);
  const lastToggleAtRef = useRef(0);
  // Lifecycle animation the main process asked for; 'pending' holds appearing's first frame until the window shows.
  const [lifecycle, setLifecycle] = useState<RobotInteraction['lifecycle']>('pending');
  const layoutReady = layout !== null;

  const navigate = useNavigate();
  useEffect(() => {
    if (!id) return;
    const offLifecycle = ipcBridge.agentWidget.lifecycle.on((event) => {
      if (event.conversation_id === id) setLifecycle(event.animation);
    });
    // One robot per VA Bot: it moves to the bot's newest (or a picked) conversation without reloading or replaying.
    const offRetarget = ipcBridge.agentWidget.retargeted.on((event) => {
      if (event.conversation_id === id) void navigate(`/widget/${encodeURIComponent(event.to)}`, { replace: true });
    });
    return () => {
      offLifecycle();
      offRetarget();
    };
  }, [id, navigate]);

  // First frames decoded → the main process shows the window and asks for `appearing`. Once per page load: a
  // retarget keeps the page (and never replays), while a reloaded page reports again and replays.
  const readySentRef = useRef(false);
  const conversationLoaded = !isLoading;
  useEffect(() => {
    if (!id || !layoutReady || !conversationLoaded || readySentRef.current) return;
    let cancelled = false;
    const ready = () => {
      if (cancelled || readySentRef.current) return;
      readySentRef.current = true;
      void ipcBridge.agentWidget.rendererReady
        .invoke({
          conversation_id: id,
          agent_id: conversation?.assistant?.id,
          modified_at: conversation?.modified_at,
        })
        .catch(() => {});
      void preloadRobotStrips(LIKELY_NEXT_STRIPS).catch(() => {});
    };
    preloadRobotStrips(ESSENTIAL_STRIPS).then(ready, ready);
    return () => {
      cancelled = true;
    };
  }, [id, layoutReady, conversationLoaded, conversation]);

  const onClipEnd = useCallback(
    (strip: RobotStrip) => {
      if (strip === 'turn-to-user') advancePresentation();
      if (strip !== 'appearing' && strip !== 'disappearing') return;
      // After appearing, the runtime state shows again; after disappearing, the last frame stays until hidden.
      if (strip === 'appearing') setLifecycle(null);
      void ipcBridge.agentWidget.animationDone.invoke({ conversation_id: id, animation: strip }).catch(() => {});
    },
    [id, advancePresentation]
  );

  // The main process needs the runtime state (idle walking pauses for anything else) and whether a turn is playing.
  useEffect(() => {
    if (!id) return;
    void ipcBridge.agentWidget.reportState.invoke({ conversation_id: id, state, transitioning }).catch(() => {});
  }, [id, state, transitioning]);

  // While the dropped robot falls, step the fall once per display frame so its path is smooth (main-process timers
  // tick unevenly on Windows). The main process stops the fall itself; this loop ends when the phase changes.
  const landing = layout?.drag_phase === 'landing';
  useEffect(() => {
    if (!id || !landing) return;
    let frame = requestAnimationFrame(function step() {
      void ipcBridge.agentWidget.landStep.invoke({ conversation_id: id }).catch(() => {});
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [id, landing]);
  const pressRef = useRef<{ startX: number; startY: number; dragging: boolean } | null>(null);
  const ignoreRef = useRef<boolean | null>(null);
  const target = { conversation_id: id };

  // The name pill shows only while the pointer is over the robot. CSS :hover can stick in this always-on-top window
  // (it moves away under a still cursor, or loses the mouse to the desktop without a leave event), so hover is
  // tracked from pointer events and expires after a short idle.
  const [nameVisible, setNameVisible] = useState(false);
  const nameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideName = useCallback(() => {
    if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
    nameTimerRef.current = null;
    setNameVisible(false);
  }, []);
  const showName = useCallback(() => {
    setNameVisible(true);
    if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
    nameTimerRef.current = setTimeout(hideName, NAME_HOVER_IDLE_MS);
  }, [hideName]);
  useEffect(() => {
    window.addEventListener('blur', hideName);
    document.addEventListener('mouseleave', hideName);
    return () => {
      window.removeEventListener('blur', hideName);
      document.removeEventListener('mouseleave', hideName);
      if (nameTimerRef.current) clearTimeout(nameTimerRef.current);
    };
  }, [hideName]);

  useEffect(() => {
    if (!id) return;
    void ipcBridge.agentWidget.getSnapshot
      .invoke({ conversation_id: id })
      .then((snapshot) => {
        if (!snapshot) return;
        setLayout(snapshot.layout);
        setSettings(snapshot.settings);
      })
      .catch(() => {});
    const offLayout = ipcBridge.agentWidget.layoutChanged.on((next) => {
      if (next.conversation_id === id) setLayout(next);
    });
    const offSettings = ipcBridge.agentWidget.settingsChanged.on(setSettings);
    return () => {
      offLayout();
      offSettings();
    };
  }, [id]);

  // The conversation was deleted, or is a regular chat (robots are for VA Bots only): drop the widget.
  useEffect(() => {
    const regularChat =
      conversation && !isVaBotAgent(conversation.assistant, configService.get(DEFAULT_AGENT_SETTING_KEY));
    if (id && !isLoading && (conversation === null || regularChat)) {
      void ipcBridge.agentWidget.remove.invoke({ conversation_id: id }).catch(() => {});
    }
  }, [id, isLoading, conversation]);

  // Archived or deleted from this robot's own history panel: the main window's listener never hears this window's
  // events, so drop the robot here (as the main window does when the chat is archived or deleted there).
  useEffect(() => {
    if (!id) return;
    const removeIfCurrent = (conversationId: string) => {
      if (conversationId === id) void ipcBridge.agentWidget.remove.invoke({ conversation_id: id }).catch(() => {});
    };
    const offArchived = addEventListener('conversation.archived', removeIfCurrent);
    const offDeleted = addEventListener('conversation.deleted', removeIfCurrent);
    return () => {
      offArchived();
      offDeleted();
    };
  }, [id]);

  // History loads lazily on the first open, and the chat unmounts when it goes back to the main window.
  useEffect(() => {
    if (expanded) setChatMounted(true);
  }, [expanded]);
  useEffect(() => {
    if (chatLocation === 'main') setChatMounted(false);
  }, [chatLocation]);

  // Collapsed, the window is just the robot's box, so it is always clickable. With the popup
  // open, only the transparent strip beside the robot passes clicks through to the desktop.
  const setIgnoreMouse = useCallback(
    (ignore: boolean) => {
      if (ignoreRef.current === ignore) return;
      ignoreRef.current = ignore;
      void ipcBridge.agentWidget.setIgnoreMouse.invoke({ conversation_id: id, ignore }).catch(() => {});
    },
    [id]
  );
  useEffect(() => {
    if (id) setIgnoreMouse(false);
  }, [id, expanded, setIgnoreMouse]);

  const setExpanded = (next: boolean): void => {
    const now = Date.now();
    if (now - lastToggleAtRef.current < CLICK_DEBOUNCE_MS) return;
    lastToggleAtRef.current = now;
    void ipcBridge.agentWidget.setExpanded.invoke({ ...target, expanded: next });
  };
  const endPress = (cancelled: boolean) => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) return;
    if (press.dragging) void ipcBridge.agentWidget.dragEnd.invoke(target);
    else if (!cancelled) setExpanded(!expanded);
  };

  if (!layout) return null;
  const name = conversation?.name?.trim() || t('pet.widget.untitledAgent');

  return (
    <div
      className={styles.root}
      data-vertical={layout.popup_vertical}
      style={
        {
          '--bot-size': `${layout.bot_size}px`,
          '--hop-height': `${HOP_HEIGHT_PHYSICAL_PX / (window.devicePixelRatio || 1)}px`,
        } as React.CSSProperties
      }
      onMouseMove={(e) => {
        if (expanded && !pressRef.current) setIgnoreMouse(!(e.target as Element).closest(WIDGET_HIT_SELECTOR));
      }}
    >
      {(chatMounted || expanded) && (
        <WidgetChatPopup
          conversation={conversation}
          name={name}
          state={state}
          layout={layout}
          visible={expanded}
          chatReady={chatMounted && chatLocation === 'widget'}
          onMinimize={() => setExpanded(false)}
          onClose={() => void ipcBridge.agentWidget.setChatLocation.invoke({ ...target, location: 'main' })}
          onReturnToMain={() => void ipcBridge.agentWidget.openInMain.invoke(target)}
          onOpenBotSettings={(agent_id) =>
            void ipcBridge.agentWidget.openAgentSettings.invoke({ ...target, agent_id }).catch(() => {})
          }
          onHideWidget={() => void ipcBridge.agentWidget.hide.invoke(target)}
          onShowConversation={(to) =>
            void ipcBridge.agentWidget.showConversation.invoke({ ...target, to }).catch(() => {})
          }
        />
      )}
      <div
        className={styles.bot}
        style={{ left: layout.bot_offset_x }}
        data-widget-hit
        role='button'
        tabIndex={0}
        aria-label={t('pet.widget.openChat', { name })}
        aria-expanded={expanded}
        // A mouse press must not focus the robot (the keyboard focus ring would stay on after a click or drag).
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          pressRef.current = { startX: e.screenX, startY: e.screenY, dragging: false };
        }}
        onPointerEnter={showName}
        onPointerLeave={hideName}
        onPointerMove={(e) => {
          const press = pressRef.current;
          if (!press) {
            showName();
            return;
          }
          // While carried, every pointer move (one per frame) moves the robot, so its path tracks the mouse.
          if (press.dragging) {
            void ipcBridge.agentWidget.dragMove.invoke(target).catch(() => {});
            return;
          }
          const travel =
            Math.hypot(e.screenX - press.startX, e.screenY - press.startY) * (window.devicePixelRatio || 1);
          if (travel <= DRAG_THRESHOLD_PHYSICAL_PX) return;
          press.dragging = true;
          wake();
          void ipcBridge.agentWidget.dragStart.invoke(target);
        }}
        onPointerUp={() => endPress(false)}
        onPointerCancel={() => endPress(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
      >
        <RobotSprite
          visual={resolveRobotVisual(presentation, state, {
            facing: layout.facing,
            moving: layout.moving,
            reduceMotion,
            awaitingUser,
            interaction: { lifecycle, dragPhase: layout.drag_phase },
          })}
          state={state}
          size={layout.bot_size}
          reduceMotion={reduceMotion}
          glowColor={botColor}
          onClipEnd={onClipEnd}
        />
        {state === 'notification' && <span className={styles.badge} aria-label={t('pet.widget.state.notification')} />}
        {!expanded && lifecycle === null && layout.drag_phase === 'none' && (
          <span className={styles.marker} data-visible={nameVisible} aria-hidden>
            <VaBotColorDot assistant={conversation?.assistant} size={6} className={styles.markerDot} />
            {conversation?.assistant?.name || name}
          </span>
        )}
      </div>
    </div>
  );
};

export default AgentWidgetPage;
