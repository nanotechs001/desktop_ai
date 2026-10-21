/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { BrowserWindow, screen } from 'electron';
import { ipcBridge } from '@/common';
import { initMainAdapterWithWindow } from '@/common/adapter/main';
import type {
  AgentAnimationState,
  AgentChatLocation,
  AgentWidgetHiddenRobot,
  AgentWidgetLayout,
  AgentWidgetPersistedState,
  AgentWidgetRecord,
  AgentWidgetRobot,
  AgentWidgetSettings,
  AgentWidgetDragPhase,
  AgentWidgetLifecycleAnimation,
  AgentWidgetSnapshot,
} from '@/common/types/agent/agentWidget';
import { DROP_IMPACT_MS, isHttpUrl, robotAnimationMs } from '@/common/types/agent/agentWidget';
import { mergeSettings, normalizeWidgetState, processConfigIO, type WidgetStateIO } from './agentWidgetStore';
import {
  carriedPosition,
  computePlacement,
  landingY,
  getWalkTrack,
  followTarget,
  stepToward,
  ratioFromX,
  resolveSlot,
  xFromRatio,
  type DisplayLike,
  type Rect,
  type WalkTrack,
  type WidgetPlacement,
} from './widgetGeometry';

/** What the app shell provides; keeps window URLs/preload paths owned by index.ts. */
export type AgentWidgetHost = {
  preloadPath: string;
  loadWidget: (win: BrowserWindow, conversationId: string) => void;
  getMainWindow: () => BrowserWindow | null;
};

const BASE_BOT_SIZE = 88;
const POPUP_SIZE = { width: 380, height: 540 };
const DRAG_TICK_MS = 16;
// Bounds that differ by at most this much after a move are DIP rounding, not a display rescale.
const DPI_ROUNDING_TOLERANCE_PX = 1;
// The fallback drag/fall timers only move the robot when the renderer's per-frame steps have gone quiet this long.
const FRAME_IDLE_MS = 50;
// Same safety net as the desktop pet: a lost pointerup must never leave the robot glued to the cursor
// (counted from the last pointer move, so a long, steady drag is not cut short).
const DRAG_WATCHDOG_MS = 8000;
const GLIDE_TICK_MS = 50;
const GLIDE_PX_PER_TICK = 2;
// Room above a collapsed robot for its slime hop (the hop itself is drawn by the renderer).
const HOP_HEADROOM_PX = 12;
// Targets closer than this never turn the robot: no direction flicker on tiny moves.
const DIRECTION_DEADBAND_PX = 6;
// The robot turns toward the mouse only when it is clearly to one side (no flipping as the mouse jitters).
const FACE_MOUSE_DEADBAND_PX = 24;
// Pause to turn around before walking the other way (also the pause at a screen edge).
const TURN_PAUSE_MS = 250;
const WANDER_CHECK_MS = 1000;
const BLUR_COLLAPSE_DELAY_MS = 150;
// Windows may hand focus to a just-shown window and take it back during the resize; ignore that.
const OPEN_BLUR_GRACE_MS = 600;
const MAX_DRAFT_LENGTH = 100_000;
// A renderer that never reports its first frames (crash, failed load) still gets its window shown. Generous:
// a dev build can take several seconds to load and decode.
const READY_FALLBACK_MS = 8000;
// Extra time a lifecycle animation gets before the main process stops waiting for the renderer to report it.
const LIFECYCLE_SLACK_MS = 1000;
const LAND_TICK_MS = 16;
const WANDER_DELAY_MS: Record<AgentWidgetSettings['movementFrequency'], [number, number]> = {
  low: [6_000, 15_000],
  medium: [3_000, 8_000],
  high: [1_500, 4_000],
};
// A newly shown robot takes its first stroll soon, so it visibly lives on the taskbar.
const FIRST_WANDER_DELAY_MS: [number, number] = [5_000, 10_000];

/**
 * Window lifecycle: loading (created, hidden, first frames decoding) -> appearing (shown, plays `appearing`,
 * not clickable) -> live -> disappearing (plays `disappearing`, not clickable) -> hidden (suspended) or destroyed.
 */
type WidgetPhase = 'loading' | 'appearing' | 'live' | 'disappearing' | 'hidden';

type WidgetEntry = {
  record: AgentWidgetRecord;
  phase: WidgetPhase;
  /** What happens once `disappearing` has played: hide the window (suspended) or destroy it. */
  afterOut: 'hide' | 'destroy' | null;
  lifecycleTimer: ReturnType<typeof setTimeout> | null;
  win: BrowserWindow;
  state: AgentAnimationState;
  displayId: number;
  /** Absolute screen x (DIP) of the robot's left edge. */
  botX: number;
  dragging: boolean;
  /** Pointer position inside the robot box when the drag started. */
  grab: { x: number; y: number };
  /** The robot box's top while carried or falling (null = standing on the walk track). */
  airY: number | null;
  dragPhase: AgentWidgetDragPhase;
  landTimer: ReturnType<typeof setInterval> | null;
  /** The fall in progress after a drop: from/to window-top y, start (ms epoch) and duration. */
  landing: { fromY: number; toY: number; startedAt: number; durationMs: number } | null;
  /** When the renderer last stepped the fall (ms epoch; 0 = not yet). */
  lastLandStepAt: number;
  dragTimer: ReturnType<typeof setInterval> | null;
  dragWatchdog: ReturnType<typeof setTimeout> | null;
  /** When the renderer last reported a pointer move during the current drag (ms epoch; 0 = none yet). */
  lastDragMoveAt: number;
  glideTimer: ReturnType<typeof setInterval> | null;
  /** Pending start of a glide after the robot turned to face its target. */
  turnTimer: ReturnType<typeof setTimeout> | null;
  facing: 'left' | 'right';
  moving: boolean;
  /** The renderer is playing a turn-to-user / turn-away transition: never walk during it. */
  transitioning: boolean;
  resizing: boolean;
  /** The popup window has had keyboard focus since it last opened; only then does a blur mean "clicked outside". */
  focusedSinceOpen: boolean;
  openedAt: number;
  nextWanderAt: number;
  lastLayoutKey: string;
  lastSize: { width: number; height: number };
  /** Open the popup as soon as the robot is live (asked for while it was still loading, appearing or away). */
  expandWhenLive: boolean;
};

export class AgentWidgetManager {
  private state: AgentWidgetPersistedState = normalizeWidgetState(undefined);
  private readonly entries = new Map<string, WidgetEntry>();
  /** Send-box drafts in flight between the main window and a widget. */
  private readonly drafts = new Map<string, string>();
  private wanderTimer: ReturnType<typeof setInterval> | null = null;
  /** Conversations whose chat the user is watching in the main window: their robots step away meanwhile. */
  private readonly suspended = new Set<string>();
  private readonly relayoutAll = () => {
    for (const entry of this.entries.values()) {
      const display = this.displayById(entry.displayId) ?? this.defaultDisplay();
      entry.displayId = display.id;
      entry.botX = xFromRatio(this.track(display), entry.record.x_ratio);
      this.place(entry);
    }
  };

  constructor(
    private readonly host: AgentWidgetHost,
    private readonly io: WidgetStateIO = processConfigIO,
    private readonly random: () => number = Math.random
  ) {}

  async init(): Promise<void> {
    this.state = normalizeWidgetState(await this.io.read());
    screen.on('display-added', this.relayoutAll);
    screen.on('display-removed', this.relayoutAll);
    screen.on('display-metrics-changed', this.relayoutAll);
    this.wanderTimer = setInterval(() => this.tickWander(), WANDER_CHECK_MS);
    this.restoreAll();
  }

  dispose(): void {
    screen.removeListener('display-added', this.relayoutAll);
    screen.removeListener('display-removed', this.relayoutAll);
    screen.removeListener('display-metrics-changed', this.relayoutAll);
    if (this.wanderTimer) clearInterval(this.wanderTimer);
    this.wanderTimer = null;
    this.closeAllWindows();
  }

  /** Re-open every non-hidden widget (startup, re-enable, main window re-created). Idempotent. */
  restoreAll(): void {
    if (!this.state.settings.enabled) return;
    for (const record of Object.values(this.state.widgets)) {
      if (!record.hidden && this.needsWindow(record.conversation_id)) this.open(record);
    }
  }

  /** Destroy windows but keep saved records, e.g. when the main window closes so the app can quit. */
  closeAllWindows(): void {
    // Deleting the current key while iterating a Map is safe.
    for (const id of this.entries.keys()) this.closeWindow(id);
    this.suspended.clear();
  }

  getSettings(): AgentWidgetSettings {
    return this.state.settings;
  }

  setSettings(patch: Partial<AgentWidgetSettings>): AgentWidgetSettings {
    const prev = this.state.settings;
    const next = mergeSettings(prev, patch);
    this.state.settings = next;
    if (next.enabled !== prev.enabled) {
      if (next.enabled) this.restoreAll();
      else for (const entry of this.entries.values()) this.disappear(entry, 'destroy');
    } else {
      for (const entry of this.entries.values()) this.applyAlwaysOnTop(entry.win);
      if (next.scale !== prev.scale) this.relayoutAll();
      if (next.reduceMotion || !next.autonomousMovement) for (const e of this.entries.values()) this.stopGlide(e);
    }
    ipcBridge.agentWidget.settingsChanged.emit(next);
    void this.persist();
    return next;
  }

  /**
   * Create the widget for a ready conversation. Returns whether a widget is
   * showing afterwards. Never creates a second window for the same conversation.
   * Without `force` (auto-launch), respects the autoLaunch setting and a widget
   * the user explicitly hid.
   */
  ensure(conversationId: string, force = false, agentId?: string): boolean {
    if (!this.state.settings.enabled) return false;
    // One robot per VA Bot: a new conversation of a bot that already has a robot moves that robot over.
    const sibling = agentId ? this.recordForAgent(agentId, conversationId) : undefined;
    if (sibling) this.retarget(sibling.conversation_id, conversationId);
    const existing = this.state.widgets[conversationId];
    if (!force && (existing ? existing.hidden : !this.state.settings.autoLaunch)) return false;
    const wasHidden = existing?.hidden === true;
    const record: AgentWidgetRecord = existing ?? {
      widget_id: randomUUID(),
      conversation_id: conversationId,
      expanded: false,
      hidden: false,
      chat_location: 'main',
    };
    record.hidden = false;
    if (agentId) record.agent_id = agentId;
    this.state.widgets[conversationId] = record;
    if (this.needsWindow(conversationId)) this.open(record);
    void this.persist();
    if (wasHidden || sibling?.hidden) this.emitHiddenChanged();
    if (!existing || wasHidden) this.emitRobotsChanged();
    return true;
  }

  /** Show the robot if needed and open its chat popup; a robot still on its way in opens it once it is live. */
  openPopup(conversationId: string, agentId?: string): boolean {
    if (!this.ensure(conversationId, true, agentId)) return false;
    // The chat leaves the main window now, so a robot stepped away for it (suspended) comes back.
    this.setChatLocation(conversationId, 'widget');
    const entry = this.entries.get(conversationId);
    if (entry?.phase === 'live') this.setExpanded(conversationId, true);
    else if (entry) entry.expandWhenLive = true;
    return true;
  }

  /** Robots the user hid, so the app can offer to show them again. */
  listHidden(): AgentWidgetHiddenRobot[] {
    return Object.values(this.state.widgets)
      .filter((record) => record.hidden)
      .map((record) => ({ conversation_id: record.conversation_id, agent_id: record.agent_id }));
  }

  private emitHiddenChanged(): void {
    ipcBridge.agentWidget.hiddenChanged.emit(this.listHidden());
  }

  /** Every robot, on the desktop or hidden, for the titlebar robot list. */
  listRobots(): AgentWidgetRobot[] {
    return Object.values(this.state.widgets).map((record) => ({
      conversation_id: record.conversation_id,
      agent_id: record.agent_id,
      hidden: record.hidden,
    }));
  }

  private emitRobotsChanged(): void {
    ipcBridge.agentWidget.robotsChanged.emit(this.listRobots());
  }

  /** Remove the desktop widget only; the agent keeps running and the chat returns to the main window. */
  hide(conversationId: string): void {
    const record = this.state.widgets[conversationId];
    if (!record) return;
    this.setChatLocation(conversationId, 'main');
    record.hidden = true;
    record.expanded = false;
    const entry = this.entries.get(conversationId);
    if (entry) this.disappear(entry, 'destroy');
    void this.persist();
    this.emitHiddenChanged();
    this.emitRobotsChanged();
  }

  /** The conversation is gone (deleted/archived/terminated): drop window, draft and saved state. */
  remove(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (entry) this.disappear(entry, 'destroy');
    this.drafts.delete(conversationId);
    const record = this.state.widgets[conversationId];
    if (record) {
      delete this.state.widgets[conversationId];
      void this.persist();
      if (record.hidden) this.emitHiddenChanged();
      this.emitRobotsChanged();
    }
  }

  getSnapshot(conversationId: string): AgentWidgetSnapshot | null {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.afterOut === 'destroy') return null;
    return { record: { ...entry.record }, settings: this.state.settings, layout: this.layoutFor(entry) };
  }

  setExpanded(conversationId: string, expanded: boolean): void {
    const entry = this.entries.get(conversationId);
    // The popup only opens on a robot that has fully appeared (not while it materializes or vanishes).
    if (!entry || entry.record.expanded === expanded || (expanded && entry.phase !== 'live')) return;
    entry.record.expanded = expanded;
    entry.focusedSinceOpen = false;
    entry.openedAt = Date.now();
    if (expanded) {
      this.stopGlide(entry);
      this.finishLanding(entry);
      this.setChatLocation(conversationId, 'widget');
    }
    this.place(entry);
    if (expanded && !entry.win.isDestroyed()) entry.win.focus();
    if (expanded) this.followInMain(conversationId);
  }

  setChatLocation(conversationId: string, location: AgentChatLocation): void {
    const record = this.state.widgets[conversationId];
    const entry = this.entries.get(conversationId);
    // The chat came back to the main window: a popup still waiting for the robot to appear is no longer wanted.
    if (location === 'main' && entry) entry.expandWhenLive = false;
    if (!record || record.chat_location === location) return;
    record.chat_location = location;
    if (location === 'main' && entry?.record.expanded) {
      entry.record.expanded = false;
      this.place(entry);
    }
    ipcBridge.agentWidget.chatLocationChanged.emit({ conversation_id: conversationId, location });
    void this.persist();
  }

  /** Conversations whose chat currently lives in an open widget (everything else is in the main window). */
  getChatLocations(): Record<string, AgentChatLocation> {
    const result: Record<string, AgentChatLocation> = {};
    for (const [id, entry] of this.entries) {
      if (entry.record.chat_location === 'widget') result[id] = 'widget';
    }
    return result;
  }

  handoffDraft(conversationId: string, text: string): void {
    const record = this.state.widgets[conversationId];
    if (!record || !text) return;
    this.drafts.set(conversationId, text.slice(0, MAX_DRAFT_LENGTH));
    ipcBridge.agentWidget.draftReady.emit({ conversation_id: conversationId, to: record.chat_location });
  }

  takeDraft(conversationId: string): string {
    const text = this.drafts.get(conversationId) ?? '';
    this.drafts.delete(conversationId);
    return text;
  }

  reportState(conversationId: string, state: AgentAnimationState, transitioning = false): void {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    entry.state = state;
    entry.transitioning = transitioning;
    if (state !== 'idle' || transitioning) this.stopGlide(entry);
  }

  setIgnoreMouse(conversationId: string, ignore: boolean): void {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.win.isDestroyed()) return;
    // Linux cannot forward mouse moves to an ignoring window, so click-through would never turn back off.
    if (process.platform !== 'linux') entry.win.setIgnoreMouseEvents(ignore, { forward: true });
  }

  /**
   * The renderer saw the pointer cross its drag threshold. The robot leaves the taskbar and follows the pointer
   * (keeping the grab offset) anywhere in the work area, across monitors; walking and the popup stop meanwhile.
   */
  dragStart(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.phase !== 'live') return;
    if (entry.dragging) this.dragEnd(conversationId);
    this.stopGlide(entry);
    this.finishLanding(entry);
    if (entry.record.expanded) this.setExpanded(conversationId, false);
    const cursor = screen.getCursorScreenPoint();
    const top = entry.airY ?? this.currentTrack(entry).y;
    entry.grab = { x: cursor.x - entry.botX, y: cursor.y - top };
    entry.dragging = true;
    entry.dragPhase = 'dragging';
    this.place(entry);
    entry.lastDragMoveAt = 0;
    // Fallback only: the robot normally follows the renderer's pointer moves (dragMove), which arrive once per
    // frame. Windows timers fire at ~15.6 ms granularity, so a timer-driven path stutters (16 / 31 ms steps).
    entry.dragTimer = setInterval(() => {
      if (entry.win.isDestroyed()) return this.dragEnd(conversationId);
      if (Date.now() - entry.lastDragMoveAt < FRAME_IDLE_MS) return;
      this.followCursor(entry);
    }, DRAG_TICK_MS);
    this.armDragWatchdog(entry, conversationId);
  }

  /** The pointer moved during a drag: follow it now, in step with the mouse, and keep the drag alive. */
  dragMove(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry || !entry.dragging || entry.win.isDestroyed()) return;
    entry.lastDragMoveAt = Date.now();
    this.followCursor(entry);
    this.armDragWatchdog(entry, conversationId);
  }

  private followCursor(entry: WidgetEntry): void {
    const point = screen.getCursorScreenPoint();
    // Following the cursor's display lets the robot be dragged across monitors.
    const display = screen.getDisplayNearestPoint(point);
    entry.displayId = display.id;
    const pos = carriedPosition(point, entry.grab, display.workArea, this.botSize());
    if (pos.x === entry.botX && pos.y === entry.airY) return;
    entry.botX = pos.x;
    entry.airY = pos.y;
    this.place(entry);
  }

  /** A drag whose release never arrives (e.g. the pointer-up was lost) ends after a quiet spell. */
  private armDragWatchdog(entry: WidgetEntry, conversationId: string): void {
    if (entry.dragWatchdog) clearTimeout(entry.dragWatchdog);
    entry.dragWatchdog = setTimeout(() => this.dragEnd(conversationId), DRAG_WATCHDOG_MS);
  }

  /**
   * Released (or cancelled): pick the landing spot on the nearest taskbar edge, then fall onto it in step with
   * drop-landing (touching down at its impact frame) and save the spot. Reduce motion lands at once.
   */
  dragEnd(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry || !entry.dragging) return;
    this.clearDrag(entry);
    const display = this.displayById(entry.displayId) ?? this.defaultDisplay();
    const track = this.track(display);
    entry.botX = resolveSlot(entry.botX, this.otherXs(display.id, conversationId), track, this.botSize());
    this.savePosition(entry, track);
    const fromY = entry.airY ?? track.y;
    if (this.state.settings.reduceMotion) {
      this.endLanding(entry);
      return;
    }
    entry.dragPhase = 'landing';
    this.place(entry);
    entry.landing = { fromY, toY: track.y, startedAt: Date.now(), durationMs: robotAnimationMs('drop-landing') };
    entry.lastLandStepAt = 0;
    // Fallback only: the robot's renderer steps the fall once per display frame (landStep). Windows timers fire at
    // ~15.6 ms granularity, so a timer-driven fall stutters.
    entry.landTimer = setInterval(() => {
      if (Date.now() - entry.lastLandStepAt < FRAME_IDLE_MS) return;
      this.stepLanding(entry);
    }, LAND_TICK_MS);
  }

  /** A display frame of the falling robot's renderer: move it to where the fall is now. */
  landStep(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.dragPhase !== 'landing' || entry.win.isDestroyed()) return;
    entry.lastLandStepAt = Date.now();
    this.stepLanding(entry);
  }

  private stepLanding(entry: WidgetEntry): void {
    const landing = entry.landing;
    if (!landing) return;
    const elapsed = Date.now() - landing.startedAt;
    if (elapsed >= landing.durationMs) return this.endLanding(entry);
    const y = landingY(landing.fromY, landing.toY, elapsed, DROP_IMPACT_MS);
    if (y === entry.airY) return;
    entry.airY = y;
    this.place(entry);
  }

  /** The user is watching this VA Bot's chat in the main window: the robot steps away until they stop. */
  setSuspended(conversationId: string, suspended: boolean): void {
    if (suspended) this.suspended.add(conversationId);
    else this.suspended.delete(conversationId);
    const entry = this.entries.get(conversationId);
    if (!entry || entry.afterOut === 'destroy') return;
    if (suspended && (entry.phase === 'appearing' || entry.phase === 'live')) this.disappear(entry, 'hide');
    else if (!suspended && (entry.phase === 'hidden' || entry.phase === 'disappearing')) this.appear(entry);
  }

  /**
   * The widget renderer has its first frames ready: show the window (unless suspended) and play `appearing`. A
   * renderer that reports in after the fallback already showed it missed that `appearing`, so it plays it now.
   */
  rendererReady(conversationId: string, info: { agent_id?: string; modified_at?: number } = {}): void {
    const entry = this.entries.get(conversationId);
    if (!entry || entry.afterOut === 'destroy') return;
    if (info.agent_id) {
      entry.record.agent_id = info.agent_id;
      if (info.modified_at !== undefined) entry.record.modified_at = info.modified_at;
      // Older builds made one robot per conversation: keep only the newest conversation's robot per bot.
      const sibling = this.recordForAgent(info.agent_id, conversationId);
      if (sibling && !sibling.hidden) {
        const keepThis = (entry.record.modified_at ?? 0) >= (sibling.modified_at ?? 0);
        this.remove(keepThis ? sibling.conversation_id : conversationId);
        if (!keepThis) return;
      }
      void this.persist();
    }
    if (entry.phase === 'loading') {
      this.clearLifecycleTimer(entry);
      if (this.suspended.has(conversationId)) entry.phase = 'hidden';
      else this.appear(entry);
    } else if (entry.phase === 'appearing' || entry.phase === 'live') {
      this.stopGlide(entry);
      this.appear(entry);
    }
  }

  animationDone(conversationId: string, animation: AgentWidgetLifecycleAnimation): void {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    if (animation === 'appearing' && entry.phase === 'appearing') {
      this.clearLifecycleTimer(entry);
      entry.phase = 'live';
      this.setIgnoreMouse(conversationId, false);
      if (entry.expandWhenLive) {
        entry.expandWhenLive = false;
        this.setExpanded(conversationId, true);
      }
    } else if (animation === 'disappearing' && entry.phase === 'disappearing') {
      this.finishDisappearing(entry);
    }
  }

  /**
   * Move a robot to another conversation of the same VA Bot (its newest session, or one picked from its history).
   * The window stays and nothing replays; the old conversation's chat goes back to the main window.
   */
  retarget(from: string, to: string): void {
    const record = this.state.widgets[from];
    if (!record || from === to) return;
    if (this.state.widgets[to]) {
      this.closeWindow(to);
      delete this.state.widgets[to];
    }
    // An open popup stays open on the new conversation (picked from the bot's history).
    const wasExpanded = record.expanded;
    if (record.chat_location === 'widget') this.setChatLocation(from, 'main');
    delete this.state.widgets[from];
    this.drafts.delete(from);
    record.conversation_id = to;
    record.chat_location = 'main';
    record.modified_at = Date.now();
    this.state.widgets[to] = record;
    const entry = this.entries.get(from);
    if (entry) {
      this.entries.delete(from);
      this.entries.set(to, entry);
      ipcBridge.agentWidget.retargeted.emit({ conversation_id: from, to });
      entry.lastLayoutKey = '';
      this.place(entry);
      if (wasExpanded) this.setExpanded(to, true);
    }
    void this.persist();
    this.emitRobotsChanged();
  }

  /** Restore, show and focus the main window; null when there is none. */
  private focusMain(): BrowserWindow | null {
    const main = this.host.getMainWindow();
    if (!main || main.isDestroyed()) return null;
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    return main;
  }

  openInMain(conversationId: string): void {
    this.setChatLocation(conversationId, 'main');
    // Same channel the tray menu uses; Layout.tsx navigates to the conversation.
    this.focusMain()?.webContents.send('tray:navigate-to-conversation', { conversation_id: conversationId });
  }

  /** Show the main window on a VA Bot's settings; the chat stays in its popup. */
  openAgentSettings(agentId: string): void {
    // Same bridge as the tray channels (preload turns it into a window event); Layout.tsx navigates.
    this.focusMain()?.webContents.send('tray:open-agent-settings', { agent_id: agentId });
  }

  /**
   * Show a link clicked in a robot's chat in the main window's browser pane, on that conversation; the chat stays
   * in its popup. Only http(s) links are forwarded.
   */
  openLinkInMain(conversationId: string, url: string): void {
    // Only a live robot may ask: the bridge is also reachable from WebUI sockets.
    if (!this.entries.has(conversationId) || !isHttpUrl(url)) return;
    this.focusMain()?.webContents.send('tray:open-link-in-conversation', { conversation_id: conversationId, url });
  }

  /**
   * The chat in a robot's popup changed (opened, a new chat, one from its history): the main window may switch its
   * browser pane to it (Layout.tsx decides). It is not brought forward.
   */
  private followInMain(conversationId: string): void {
    const main = this.host.getMainWindow();
    if (main && !main.isDestroyed())
      main.webContents.send('tray:follow-robot-chat', { conversation_id: conversationId });
  }

  /** Show the main window on a robot's conversation with its browser pane open; the chat stays in its popup. */
  watchInMain(conversationId: string): void {
    if (!this.entries.has(conversationId)) return;
    // The link channel without a link: Layout.tsx reveals the pane as it is.
    this.focusMain()?.webContents.send('tray:open-link-in-conversation', { conversation_id: conversationId });
  }

  // ---------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------

  private open(record: AgentWidgetRecord): void {
    const id = record.conversation_id;
    const display = this.displayById(record.display_id) ?? this.defaultDisplay();
    const size = this.botSize();
    const track = this.track(display);
    const botX = resolveSlot(xFromRatio(track, record.x_ratio), this.otherXs(display.id, id), track, size);
    record.expanded = false;

    const win = new BrowserWindow({
      x: botX,
      y: track.y,
      width: size,
      height: size,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: this.state.settings.alwaysOnTop,
      webPreferences: {
        preload: this.host.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        // Hidden/occluded widgets stop rendering instead of burning frames.
        backgroundThrottling: true,
      },
    });

    const entry: WidgetEntry = {
      record,
      phase: 'loading',
      afterOut: null,
      lifecycleTimer: null,
      win,
      state: 'idle',
      displayId: display.id,
      botX,
      dragging: false,
      grab: { x: 0, y: 0 },
      airY: null,
      dragPhase: 'none',
      landTimer: null,
      landing: null,
      lastLandStepAt: 0,
      dragTimer: null,
      dragWatchdog: null,
      lastDragMoveAt: 0,
      glideTimer: null,
      turnTimer: null,
      facing: 'right',
      moving: false,
      transitioning: false,
      resizing: false,
      focusedSinceOpen: false,
      openedAt: 0,
      nextWanderAt:
        Date.now() +
        FIRST_WANDER_DELAY_MS[0] +
        Math.round(this.random() * (FIRST_WANDER_DELAY_MS[1] - FIRST_WANDER_DELAY_MS[0])),
      lastLayoutKey: '',
      lastSize: { width: size, height: size },
      expandWhenLive: false,
    };
    this.entries.set(id, entry);

    this.applyAlwaysOnTop(win);
    const detachAdapter = initMainAdapterWithWindow(win);
    // The renderer has the window shown once its first frames are decoded (rendererReady), so the robot never
    // flashes a default image; this only covers a renderer that never reports in.
    win.once('ready-to-show', () => {
      entry.lifecycleTimer = setTimeout(() => {
        if (entry.phase === 'loading' && !this.suspended.has(entry.record.conversation_id)) this.appear(entry);
      }, READY_FALLBACK_MS);
    });
    win.on('focus', () => {
      if (!entry.record.expanded || entry.resizing) return;
      entry.focusedSinceOpen = true;
      // The user moved into this robot's chat (maybe from another robot's): the main window's pane follows it.
      this.followInMain(entry.record.conversation_id);
    });
    // Opening the popup hides/re-shows the window on Windows (see setBounds), which fires blur
    // before the user ever touched it. Only a blur after real focus means "clicked outside".
    win.on('blur', () => {
      if (!entry.focusedSinceOpen || Date.now() - entry.openedAt < OPEN_BLUR_GRACE_MS) return;
      setTimeout(() => {
        if (win.isDestroyed() || entry.resizing || win.isFocused() || !entry.record.expanded) return;
        this.setExpanded(entry.record.conversation_id, false); // collapse only — the agent and its chat keep running
      }, BLUR_COLLAPSE_DELAY_MS);
    });
    win.on('closed', () => {
      detachAdapter();
      this.clearDrag(entry);
      this.stopGlide(entry);
      this.stopLanding(entry);
      this.clearLifecycleTimer(entry);
      const current = entry.record.conversation_id;
      if (this.entries.get(current) === entry) this.entries.delete(current);
    });

    this.place(entry);
    this.host.loadWidget(win, id);
  }

  private closeWindow(conversationId: string): void {
    const entry = this.entries.get(conversationId);
    if (!entry) return;
    this.clearDrag(entry);
    this.stopGlide(entry);
    this.stopLanding(entry);
    this.clearLifecycleTimer(entry);
    this.entries.delete(conversationId);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }

  /** Another robot record for the same VA Bot. */
  private recordForAgent(agentId: string, exceptConversationId: string): AgentWidgetRecord | undefined {
    return Object.values(this.state.widgets).find(
      (r) => r.agent_id === agentId && r.conversation_id !== exceptConversationId
    );
  }

  /** No window, or only one already on its way out: a new one is needed. */
  private needsWindow(conversationId: string): boolean {
    const entry = this.entries.get(conversationId);
    if (entry?.afterOut === 'destroy') this.closeWindow(conversationId);
    return !this.entries.has(conversationId);
  }

  /** Show the window where the robot stands and play `appearing`; clicks pass through until it has played. */
  private appear(entry: WidgetEntry): void {
    if (entry.win.isDestroyed()) return;
    this.clearLifecycleTimer(entry);
    entry.phase = 'appearing';
    entry.afterOut = null;
    this.setIgnoreMouse(entry.record.conversation_id, true);
    this.place(entry);
    // showInactive: a robot appearing must not steal keyboard focus from the user's current app.
    entry.win.showInactive();
    this.playLifecycle(entry, 'appearing');
  }

  /**
   * Play `disappearing` in place, then hide or destroy the window. Movement, dragging, landing and the popup stop
   * first and clicks pass through. A window nobody can see goes at once.
   */
  private disappear(entry: WidgetEntry, then: 'hide' | 'destroy'): void {
    entry.expandWhenLive = false;
    if (entry.phase === 'disappearing') {
      if (then === 'destroy') entry.afterOut = 'destroy';
      return;
    }
    entry.afterOut = then;
    if (entry.win.isDestroyed() || !entry.win.isVisible() || entry.phase === 'loading' || entry.phase === 'hidden') {
      this.finishDisappearing(entry);
      return;
    }
    this.clearLifecycleTimer(entry);
    this.clearDrag(entry);
    this.stopGlide(entry);
    this.stopLanding(entry);
    entry.airY = null;
    entry.dragPhase = 'none';
    entry.phase = 'disappearing';
    this.setIgnoreMouse(entry.record.conversation_id, true);
    entry.record.expanded = false;
    this.place(entry);
    this.playLifecycle(entry, 'disappearing');
  }

  private finishDisappearing(entry: WidgetEntry): void {
    this.clearLifecycleTimer(entry);
    if (entry.afterOut === 'destroy') {
      this.closeWindow(entry.record.conversation_id);
      return;
    }
    entry.phase = 'hidden';
    entry.afterOut = null;
    if (!entry.win.isDestroyed()) entry.win.hide();
  }

  /** Ask the renderer to play a lifecycle animation; stop waiting if it never reports back (hidden, crashed). */
  private playLifecycle(entry: WidgetEntry, animation: AgentWidgetLifecycleAnimation): void {
    const id = entry.record.conversation_id;
    ipcBridge.agentWidget.lifecycle.emit({ conversation_id: id, animation });
    entry.lifecycleTimer = setTimeout(
      () => this.animationDone(id, animation),
      robotAnimationMs(animation) + LIFECYCLE_SLACK_MS
    );
  }

  private clearLifecycleTimer(entry: WidgetEntry): void {
    if (entry.lifecycleTimer) clearTimeout(entry.lifecycleTimer);
    entry.lifecycleTimer = null;
  }

  private applyAlwaysOnTop(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    if (!this.state.settings.alwaysOnTop) {
      win.setAlwaysOnTop(false);
      return;
    }
    // 'pop-up-menu' keeps the robot above normal windows on Windows/Linux, like the pet did.
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'pop-up-menu');
  }

  /** Apply the current placement to the window and tell its renderer when the layout shape changed. */
  private place(entry: WidgetEntry): void {
    if (entry.win.isDestroyed()) return;
    const placement = this.currentPlacement(entry);
    entry.botX = placement.bounds.x + placement.botOffsetX;
    this.setBounds(entry, placement.bounds);

    const layout = this.layoutFor(entry, placement);
    const key = JSON.stringify(layout);
    if (key !== entry.lastLayoutKey) {
      entry.lastLayoutKey = key;
      ipcBridge.agentWidget.layoutChanged.emit(layout);
    }
  }

  private setBounds(entry: WidgetEntry, bounds: Rect): void {
    const { win } = entry;
    const sizeChanged = bounds.width !== entry.lastSize.width || bounds.height !== entry.lastSize.height;
    if (!sizeChanged) {
      win.setPosition(bounds.x, bounds.y, false);
      this.restoreAfterDpiChange(win, bounds);
      return;
    }
    entry.lastSize = { width: bounds.width, height: bounds.height };
    // Windows does not always reflow a transparent frameless window on setBounds (electron#20729);
    // hide → setBounds → show forces DWM to rebuild it, same workaround as the pet window.
    if (process.platform !== 'win32' || !win.isVisible()) {
      win.setBounds(bounds, false);
      this.restoreAfterDpiChange(win, bounds);
      return;
    }
    entry.resizing = true;
    win.hide();
    win.setBounds(bounds, false);
    this.restoreAfterDpiChange(win, bounds);
    if (entry.record.expanded) win.show();
    else win.showInactive();
    entry.resizing = false;
  }

  /**
   * Moving onto a display with a different scale factor (e.g. a 125% laptop next to a 100% monitor) makes Windows
   * rescale the window. Put the exact bounds back, or the robot's box grows with every crossing and sinks below
   * the taskbar. Once the window is on that display, the second setBounds lands in its scale.
   * A 1px difference is only DIP↔pixel rounding at fractional scaling: correcting it would move the window twice per
   * step and make a drag jitter.
   */
  private restoreAfterDpiChange(win: BrowserWindow, bounds: Rect): void {
    const actual = win.getBounds();
    const off = (a: number, b: number) => Math.abs(a - b) > DPI_ROUNDING_TOLERANCE_PX;
    if (
      off(actual.x, bounds.x) ||
      off(actual.y, bounds.y) ||
      off(actual.width, bounds.width) ||
      off(actual.height, bounds.height)
    ) {
      win.setBounds(bounds, false);
    }
  }

  private layoutFor(entry: WidgetEntry, placement = this.currentPlacement(entry)): AgentWidgetLayout {
    return {
      conversation_id: entry.record.conversation_id,
      expanded: entry.record.expanded,
      popup_side: placement.popupSide,
      popup_vertical: placement.popupVertical,
      bot_size: this.botSize(),
      bot_offset_x: placement.botOffsetX,
      facing: entry.facing,
      moving: entry.moving,
      hop_headroom: entry.record.expanded ? 0 : this.headroom(entry),
      drag_phase: entry.dragPhase,
    };
  }

  private currentPlacement(entry: WidgetEntry): WidgetPlacement {
    const track = this.currentTrack(entry);
    const headroom = this.headroom(entry);
    const placement = computePlacement(track, entry.botX, this.botSize(), entry.record.expanded, POPUP_SIZE, headroom);
    // Carried or falling: same box, lifted off the track.
    if (entry.airY === null || entry.record.expanded) return placement;
    return { ...placement, bounds: { ...placement.bounds, y: entry.airY - headroom } };
  }

  private currentTrack(entry: WidgetEntry): WalkTrack {
    return this.track(this.displayById(entry.displayId) ?? this.defaultDisplay());
  }

  /** Hops need room above the robot; a robot hanging under a top taskbar never hops. */
  private headroom(entry: WidgetEntry): number {
    const display = this.displayById(entry.displayId) ?? this.defaultDisplay();
    return this.track(display).edge === 'top' ? 0 : HOP_HEADROOM_PX;
  }

  // ---------------------------------------------------------------------------
  // Idle wandering
  // ---------------------------------------------------------------------------

  /**
   * Every second: an idle robot faces the side the mouse is on, and at random intervals strolls a short stretch
   * toward the mouse's x position until it stands under it. The mouse on another monitor leaves it where it is.
   */
  private tickWander(): void {
    const s = this.state.settings;
    if (!s.enabled || !s.autonomousMovement || s.reduceMotion || this.entries.size === 0) return;
    const now = Date.now();
    const cursor = screen.getCursorScreenPoint();
    const cursorDisplayId = screen.getDisplayNearestPoint(cursor).id;
    for (const [id, entry] of this.entries) {
      if (entry.moving || entry.displayId !== cursorDisplayId || !this.canWander(entry)) continue;
      const display = this.displayById(entry.displayId) ?? this.defaultDisplay();
      const track = this.track(display);
      const target = followTarget(cursor.x, track, this.botSize());
      const delta = target - entry.botX;
      // Look toward the mouse while standing still.
      const facing = delta > 0 ? 'right' : 'left';
      if (Math.abs(delta) > FACE_MOUSE_DEADBAND_PX && facing !== entry.facing) {
        entry.facing = facing;
        this.place(entry);
      }
      if (entry.nextWanderAt > now) continue;
      entry.nextWanderAt = now + this.wanderDelay();
      // Already under the mouse: rest here.
      if (Math.abs(delta) <= FACE_MOUSE_DEADBAND_PX) continue;
      const stop = resolveSlot(
        stepToward(entry.botX, target, track, this.random),
        this.otherXs(display.id, id),
        track,
        this.botSize()
      );
      this.startGlide(entry, stop, track);
    }
  }

  private canWander(entry: WidgetEntry): boolean {
    return (
      entry.phase === 'live' &&
      entry.dragPhase === 'none' &&
      entry.state === 'idle' &&
      !entry.record.expanded &&
      !entry.dragging &&
      !entry.transitioning &&
      !entry.win.isDestroyed() &&
      entry.win.isVisible() &&
      !this.isHovered(entry)
    );
  }

  private startGlide(entry: WidgetEntry, target: number, track: WalkTrack): void {
    this.stopGlide(entry);
    if (Math.abs(target - entry.botX) < DIRECTION_DEADBAND_PX) return;
    // Face the destination before moving; turning around pauses briefly first.
    const facing = target > entry.botX ? 'right' : 'left';
    if (facing !== entry.facing) {
      entry.facing = facing;
      this.place(entry);
      entry.turnTimer = setTimeout(() => {
        entry.turnTimer = null;
        if (this.canWander(entry)) this.beginGlide(entry, target, track);
      }, TURN_PAUSE_MS);
      return;
    }
    this.beginGlide(entry, target, track);
  }

  /** Walk toward `target` at the unchanged glide speed; the renderer hops while `moving`. */
  private beginGlide(entry: WidgetEntry, target: number, track: WalkTrack): void {
    entry.moving = true;
    this.place(entry);
    entry.glideTimer = setInterval(() => {
      if (!this.canWander(entry)) return this.stopGlide(entry);
      const delta = target - entry.botX;
      if (Math.abs(delta) <= GLIDE_PX_PER_TICK) {
        entry.botX = target;
        this.place(entry);
        this.stopGlide(entry);
        this.savePosition(entry, track);
        return;
      }
      entry.botX += Math.sign(delta) * GLIDE_PX_PER_TICK;
      this.place(entry);
    }, GLIDE_TICK_MS);
  }

  private stopGlide(entry: WidgetEntry): void {
    if (entry.glideTimer) clearInterval(entry.glideTimer);
    if (entry.turnTimer) clearTimeout(entry.turnTimer);
    entry.glideTimer = null;
    entry.turnTimer = null;
    // Landing: the renderer drops the hop (exact base y, scale 1) as soon as `moving` clears.
    if (entry.moving) {
      entry.moving = false;
      this.place(entry);
    }
  }

  private wanderDelay(): number {
    const [min, max] = WANDER_DELAY_MS[this.state.settings.movementFrequency];
    return min + Math.round(this.random() * (max - min));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** The user is pointing at the robot right now — never walk away from under the cursor. */
  private isHovered(entry: WidgetEntry): boolean {
    const cursor = screen.getCursorScreenPoint();
    const b = entry.win.getBounds();
    return cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
  }

  private clearDrag(entry: WidgetEntry): void {
    if (entry.dragTimer) clearInterval(entry.dragTimer);
    if (entry.dragWatchdog) clearTimeout(entry.dragWatchdog);
    entry.dragTimer = null;
    entry.dragWatchdog = null;
    entry.dragging = false;
  }

  private stopLanding(entry: WidgetEntry): void {
    if (entry.landTimer) clearInterval(entry.landTimer);
    entry.landTimer = null;
    entry.landing = null;
  }

  /** Touch down exactly on the walk track and hand the robot back to its runtime state; strolls wait a while. */
  private endLanding(entry: WidgetEntry): void {
    this.stopLanding(entry);
    entry.airY = null;
    entry.dragPhase = 'none';
    entry.nextWanderAt = Date.now() + this.wanderDelay();
    this.place(entry);
  }

  /** Cut a fall short (popup opened, new drag): snap onto the track. */
  private finishLanding(entry: WidgetEntry): void {
    if (entry.dragPhase === 'landing') this.endLanding(entry);
  }

  private savePosition(entry: WidgetEntry, track: WalkTrack): void {
    entry.record.x_ratio = ratioFromX(track, entry.botX);
    entry.record.display_id = entry.displayId;
    void this.persist();
  }

  private botSize(): number {
    return Math.round(BASE_BOT_SIZE * this.state.settings.scale);
  }

  private track(display: DisplayLike): WalkTrack {
    return getWalkTrack(display, this.botSize());
  }

  private otherXs(displayId: number, exceptId: string): number[] {
    const xs: number[] = [];
    for (const [id, entry] of this.entries) {
      if (id !== exceptId && entry.displayId === displayId) xs.push(entry.botX);
    }
    return xs;
  }

  private displayById(id: number | undefined): Electron.Display | undefined {
    return id === undefined ? undefined : screen.getAllDisplays().find((d) => d.id === id);
  }

  /** The display hosting the main window, so new robots appear where the user is working. */
  private defaultDisplay(): Electron.Display {
    const main = this.host.getMainWindow();
    if (main && !main.isDestroyed()) {
      const b = main.getBounds();
      return screen.getDisplayNearestPoint({ x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) });
    }
    return screen.getPrimaryDisplay();
  }

  private persist(): Promise<unknown> {
    return this.io.write(this.state).catch((error: unknown) => {
      console.error('[AgentWidget] Failed to persist widget state:', error);
    });
  }
}
