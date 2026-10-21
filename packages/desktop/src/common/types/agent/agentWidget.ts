/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import robotAnimationManifest from '@/common/config/robotAnimationManifest.json';

/**
 * Floating agent widget — shared types between the main process (window
 * management) and the renderer (widget page + main-window sync).
 *
 * An "agent worker" in AionUi is a conversation: the aioncore backend owns its
 * runtime, message history, memory and tools. A widget is only another view of
 * that conversation, so the widget is keyed by `conversation_id` and never
 * holds chat state of its own.
 */

export const AGENT_ANIMATION_STATES = [
  'idle',
  'listening',
  'thinking',
  'talking',
  'searching',
  'working',
  'sleeping',
  'error',
  'offline',
  'notification',
] as const;

export type AgentAnimationState = (typeof AGENT_ANIMATION_STATES)[number];

export type AgentWidgetMovementFrequency = 'low' | 'medium' | 'high';

/** Where the conversation's interactive chat (message list + send box) is mounted. */
export type AgentChatLocation = 'main' | 'widget';

export type AgentWidgetSettings = {
  /** Master switch for floating widgets. */
  enabled: boolean;
  /** Spawn a widget automatically when a new conversation (agent worker) is created. */
  autoLaunch: boolean;
  /** Let idle widgets glide along the taskbar edge on their own. */
  autonomousMovement: boolean;
  movementFrequency: AgentWidgetMovementFrequency;
  /** Robot size multiplier, clamped to [MIN_WIDGET_SCALE, MAX_WIDGET_SCALE]. */
  scale: number;
  alwaysOnTop: boolean;
  /** Freeze sprite animation and autonomous movement. */
  reduceMotion: boolean;
  /** Suppress spoken output. AionUi has no TTS today; reserved so the toggle persists. */
  muteVoice: boolean;
};

/** How a robot's open popup is shown: the small popup above the robot, or a large desktop chat window. */
export type AgentWidgetWindowMode = 'compact' | 'expanded';

/** A gesture on the expanded window: moving it by its title bar, or resizing it by an edge or corner. */
export const AGENT_WIDGET_WINDOW_GESTURES = ['move', 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
export type AgentWidgetWindowGesture = (typeof AGENT_WIDGET_WINDOW_GESTURES)[number];
export type AgentWidgetGesturePhase = 'start' | 'move' | 'end';

/** Screen bounds (DIP). */
export type AgentWidgetBounds = { x: number; y: number; width: number; height: number };

/** Persisted per-widget record. One record per conversation, never more. */
export type AgentWidgetRecord = {
  widget_id: string;
  conversation_id: string;
  /** Electron display id the widget last lived on. */
  display_id?: number;
  /** Horizontal position as a 0..1 fraction of the display's walkable width (survives DPI/resolution changes). */
  x_ratio?: number;
  expanded: boolean;
  hidden: boolean;
  chat_location: AgentChatLocation;
  /** The VA Bot (assistant id) this robot stands for: one robot per bot, showing its current conversation. */
  agent_id?: string;
  /** The conversation's last change (ms), to keep the newest one when two windows claim the same bot. */
  modified_at?: number;
  /** The robot's chosen popup mode (missing = 'compact'); kept until the user changes it. */
  window_mode?: AgentWidgetWindowMode;
  /** Where the user last moved or resized the expanded window; reused while it still fits on a display. */
  expanded_bounds?: AgentWidgetBounds;
};

/** A robot the user hid ("Hide widget"); the titlebar lists these so they can be shown again. */
export type AgentWidgetHiddenRobot = { conversation_id: string; agent_id?: string };

/** A VA Bot's robot, on the desktop or hidden by the user (the titlebar robot list). */
export type AgentWidgetRobot = AgentWidgetHiddenRobot & { hidden: boolean };

export type AgentWidgetPersistedState = {
  settings: AgentWidgetSettings;
  widgets: Record<string, AgentWidgetRecord>;
};

/** Layout info pushed to the widget renderer so it can place the bot and popup pointer. */
export type AgentWidgetLayout = {
  conversation_id: string;
  expanded: boolean;
  /** Which side the popup extends toward, relative to the robot. */
  popup_side: 'left' | 'right';
  /** 'below' when the taskbar is docked at the top of the screen, and in the expanded window (robot on top). */
  popup_vertical: 'above' | 'below';
  /** Robot box size in CSS px. */
  bot_size: number;
  /** Robot's x offset inside the widget window, in CSS px. */
  bot_offset_x: number;
  /** Horizontal direction the robot faces; kept while stationary (art faces right, left is mirrored). */
  facing: 'left' | 'right';
  /** Autonomously travelling along the taskbar right now (drives the slime hop). */
  moving: boolean;
  /** Transparent room above the robot inside the window for hops, in CSS px (0 when hops can't happen). */
  hop_headroom: number;
  /** The user is carrying the robot ('dragging') or it is falling back onto the taskbar ('landing'). */
  drag_phase: AgentWidgetDragPhase;
  /** The robot's chosen popup mode; the expanded window only shows while `expanded`. */
  window_mode: AgentWidgetWindowMode;
  /** Height of the band above the panel the robot walks in, in CSS px (0 unless the expanded window is showing). */
  top_band: number;
  /** The window is easing between the compact popup and the expanded window: the popup content fades meanwhile. */
  window_transitioning: boolean;
};

export type AgentWidgetDragPhase = 'none' | 'dragging' | 'landing';

/** One-shot animations the main process asks a widget to play around showing or removing its window. */
export type AgentWidgetLifecycleAnimation = 'appearing' | 'disappearing';

export type AgentWidgetSnapshot = {
  record: AgentWidgetRecord;
  settings: AgentWidgetSettings;
  layout: AgentWidgetLayout;
};

export const MIN_WIDGET_SCALE = 0.75;
export const MAX_WIDGET_SCALE = 1.5;

export const DEFAULT_AGENT_WIDGET_SETTINGS: AgentWidgetSettings = {
  enabled: true,
  autoLaunch: true,
  autonomousMovement: true,
  movementFrequency: 'low',
  scale: 1,
  alwaysOnTop: true,
  reduceMotion: false,
  muteVoice: false,
};

/** Conversation ids are backend UUIDs; anything else is rejected at the IPC boundary. */
/** The text previews a robot window hands to the main window by content (no file behind them: a diagram, a diff). */
export const AGENT_WIDGET_PREVIEW_TYPES = ['markdown', 'diff', 'code', 'html', 'csv'] as const;
export type AgentWidgetPreviewType = (typeof AGENT_WIDGET_PREVIEW_TYPES)[number];
/** The longest preview content a robot window may forward. */
export const MAX_AGENT_WIDGET_PREVIEW_CHARS = 2_000_000;

/** A preview a robot window forwards to the main window, shown read-only there. */
export type AgentWidgetPreview = {
  content: string;
  content_type: AgentWidgetPreviewType;
  title?: string;
  file_name?: string;
  language?: string;
};

export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** True for an absolute http(s) URL: the only links a robot's chat may hand to the main window's browser. */
export const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Robot animation manifest (generated by tools/build-robot-sprites.cjs from the 30 FPS asset package). The main
 * process reads it for lifecycle/landing timings; the renderer for sprite playback.
 */
export const ROBOT_ANIMATION_MANIFEST = robotAnimationManifest;
export type RobotAnimationName = keyof typeof robotAnimationManifest.states;

/** Playback length of a manifest animation: its frames at its own fps (the manifest's outputDurationMs, unrounded). */
export function robotAnimationMs(name: RobotAnimationName): number {
  const s = robotAnimationManifest.states[name];
  return (s.frameCount * 1000) / s.fps;
}

/** A dropped robot touches the taskbar on drop-landing's 5th drawn keyframe (the squash with the splash). */
export const DROP_IMPACT_MS = 4 * robotAnimationManifest.states['drop-landing'].keyframeDurationMs;
