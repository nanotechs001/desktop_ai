/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentAnimationState,
  AgentWidgetDragPhase,
  AgentWidgetLifecycleAnimation,
  RobotAnimationName,
} from '@/common/types/agent/agentWidget';
import { ROBOT_ANIMATION_MANIFEST, robotAnimationMs } from '@/common/types/agent/agentWidget';

/**
 * Maps real agent activity (stream frames, turn lifecycle, mic, backend
 * health) to one robot animation. Activity is accumulated into a plain object
 * by `applyStreamFrame`/`applyTurnCompleted`, and `resolveAnimationState`
 * applies a single fixed priority so competing events never flicker:
 *
 *   error > offline > listening > talking > searching > working > thinking > notification > sleeping > idle
 */

export type ToolKind = 'search' | 'work';

export type AgentActivity = {
  micActive: boolean;
  offline: boolean;
  /** A turn is in flight (request accepted, not yet completed). */
  turnActive: boolean;
  /** Last assistant text chunk; "talking" while chunks keep arriving. */
  lastTextAt: number;
  /** Running tool calls by call id. */
  tools: Record<string, ToolKind>;
  lastErrorAt: number;
  /** A turn finished while nobody was looking at the chat. */
  unread: boolean;
  /** The agent is blocked on the user: a permission request or a question is waiting for an answer. */
  awaitingUser: boolean;
  lastActivityAt: number;
};

export const ERROR_HOLD_MS = 5000;
export const TALK_WINDOW_MS = 1500;
export const DEFAULT_SLEEP_AFTER_MS = 5 * 60_000;
/** An idle robot naps for a random time in this range, then wakes on its own. */
export const NAP_MS: readonly [number, number] = [2 * 60_000, 5 * 60_000];
/** …and stays awake (wandering, looking around) for a random time in this range before the next nap. */
export const AWAKE_SPELL_MS: readonly [number, number] = [60_000, 3 * 60_000];

/** Where an idle robot is in its nap-and-wake cycle: asleep or awake until `until`. */
export type RestCycle = { asleep: boolean; until: number };

const pickIn = ([min, max]: readonly [number, number], random: () => number): number =>
  min + Math.floor(random() * (max - min));

/**
 * The idle robot's rest cycle at `now`: null while it has been idle for less than `sleepAfterMs` (real activity
 * restarts that countdown), otherwise naps (NAP_MS) alternating with awake spells (AWAKE_SPELL_MS), each of a random
 * length. Returns `cycle` itself while the current phase lasts.
 */
export function advanceRestCycle(
  cycle: RestCycle | null,
  lastActivityAt: number,
  now: number,
  random: () => number = Math.random,
  sleepAfterMs = DEFAULT_SLEEP_AFTER_MS
): RestCycle | null {
  if (now - lastActivityAt <= sleepAfterMs) return null;
  if (!cycle) return { asleep: true, until: now + pickIn(NAP_MS, random) };
  if (now < cycle.until) return cycle;
  return cycle.asleep
    ? { asleep: false, until: now + pickIn(AWAKE_SPELL_MS, random) }
    : { asleep: true, until: now + pickIn(NAP_MS, random) };
}

export const createActivity = (now: number): AgentActivity => ({
  micActive: false,
  offline: false,
  turnActive: false,
  lastTextAt: 0,
  tools: {},
  lastErrorAt: 0,
  unread: false,
  awaitingUser: false,
  lastActivityAt: now,
});

/** `rest` is the idle robot's nap-and-wake cycle (see advanceRestCycle); without it, idle past `sleepAfterMs` sleeps. */
export function resolveAnimationState(
  a: AgentActivity,
  now: number,
  sleepAfterMs = DEFAULT_SLEEP_AFTER_MS,
  rest?: RestCycle | null
): AgentAnimationState {
  if (a.lastErrorAt > 0 && now - a.lastErrorAt < ERROR_HOLD_MS) return 'error';
  if (a.offline) return 'offline';
  if (a.micActive) return 'listening';
  if (a.turnActive && now - a.lastTextAt < TALK_WINDOW_MS) return 'talking';
  const kinds = Object.values(a.tools);
  if (kinds.includes('search')) return 'searching';
  if (kinds.includes('work')) return 'working';
  if (a.turnActive) return 'thinking';
  if (a.unread) return 'notification';
  if (rest === undefined ? now - a.lastActivityAt > sleepAfterMs : rest?.asleep) return 'sleeping';
  return 'idle';
}

// Browser/web tools get the "searching" animation; every other tool is "working".
const SEARCH_TOOL_PATTERN = /browser|search|web|fetch|navigate|url|crawl|scrape|chrome|page|tab|google|bing/i;

export function classifyTool(name: string | undefined): ToolKind {
  return name && SEARCH_TOOL_PATTERN.test(name) ? 'search' : 'work';
}

/** Minimal view of `IResponseMessage` — only what the mapper reads. */
export type StreamFrame = { type: string; data: unknown; position?: string };

const RUNNING_ACP = new Set(['pending', 'in_progress']);
/** Frames that stop the agent until the user answers (tool permission, ACP permission, a question card). */
const AWAITING_USER_FRAMES = new Set(['permission', 'acp_permission', 'ask']);
const RUNNING_GROUP = new Set(['Executing', 'Pending', 'Confirming']);

/** Fold one `conversation.responseStream` frame into the activity. Returns a new object. */
export function applyStreamFrame(prev: AgentActivity, frame: StreamFrame, now: number): AgentActivity {
  const a: AgentActivity = { ...prev, tools: { ...prev.tools }, lastActivityAt: now };
  const data = (frame.data ?? {}) as Record<string, unknown>;
  // Any other agent output means the agent is moving again: whatever it asked was answered.
  a.awaitingUser = AWAITING_USER_FRAMES.has(frame.type);
  switch (frame.type) {
    case 'thinking':
    case 'thought':
      a.turnActive = true;
      break;
    case 'text':
    case 'content':
      if (frame.position !== 'right') {
        a.turnActive = true;
        a.lastTextAt = now;
      }
      break;
    case 'acp_tool_call': {
      const update = (data.update ?? {}) as { tool_call_id?: string; status?: string; title?: string };
      if (!update.tool_call_id) break;
      a.turnActive = true;
      if (update.status && RUNNING_ACP.has(update.status)) a.tools[update.tool_call_id] = classifyTool(update.title);
      else delete a.tools[update.tool_call_id];
      break;
    }
    case 'tool_call': {
      const call = data as { call_id?: string; name?: string; status?: string };
      if (!call.call_id) break;
      a.turnActive = true;
      if (call.status === 'running') a.tools[call.call_id] = classifyTool(call.name);
      else delete a.tools[call.call_id];
      break;
    }
    case 'tool_group': {
      if (!Array.isArray(frame.data)) break;
      a.turnActive = true;
      for (const item of frame.data as Array<{ call_id?: string; name?: string; status?: string }>) {
        if (!item.call_id) continue;
        if (item.status && RUNNING_GROUP.has(item.status)) a.tools[item.call_id] = classifyTool(item.name);
        else delete a.tools[item.call_id];
      }
      break;
    }
    case 'agent_status':
      if (data.status === 'error') a.lastErrorAt = now;
      break;
    case 'error':
      a.lastErrorAt = now;
      break;
    case 'finish':
      a.turnActive = false;
      a.tools = {};
      break;
    default:
      break;
  }
  return a;
}

/** A turn ended: clear in-flight work; mark unread unless the user is looking at the chat. */
export function applyTurnCompleted(
  prev: AgentActivity,
  turn: { status?: string },
  chatVisible: boolean,
  now: number
): AgentActivity {
  return {
    ...prev,
    turnActive: false,
    tools: {},
    awaitingUser: false,
    lastActivityAt: now,
    lastErrorAt: turn.status === 'error' ? now : prev.lastErrorAt,
    unread: prev.unread || !chatVisible,
  };
}

// ---------------------------------------------------------------------------
// Clips: every drawable animation, read from the 30 FPS manifest (frame counts, fps, loop, duration). Nothing here
// assumes a frame count; the displayed frame always comes from elapsed time.
// ---------------------------------------------------------------------------

export type RobotStrip =
  | AgentAnimationState
  | 'turn-to-user'
  | 'facing-user'
  | 'dragging'
  | 'drop-landing'
  | 'appearing'
  | 'disappearing';

export type RobotClip = {
  /** Manifest animation (and sprite strip) this clip plays. */
  asset: RobotAnimationName;
  frameCount: number;
  fps: number;
  loop: boolean;
  durationMs: number;
};

/** Idle rests: its loop keeps the existing slow, calm cycle instead of the manifest's drawn tempo. */
export const IDLE_REST_CYCLE_MS = 2800;

function manifestClip(asset: RobotAnimationName, durationMs?: number): RobotClip {
  const s = ROBOT_ANIMATION_MANIFEST.states[asset];
  if (durationMs === undefined) {
    return { asset, frameCount: s.frameCount, fps: s.fps, loop: s.loop, durationMs: robotAnimationMs(asset) };
  }
  return { asset, frameCount: s.frameCount, fps: (s.frameCount * 1000) / durationMs, loop: s.loop, durationMs };
}

/** States without art of their own reuse the closest animation (plus a CSS treatment: ring, tint, grey, badge). */
export const ROBOT_CLIPS: Record<RobotStrip, RobotClip> = {
  idle: manifestClip('idle', IDLE_REST_CYCLE_MS),
  listening: manifestClip('talking'),
  thinking: manifestClip('thinking'),
  talking: manifestClip('talking'),
  searching: manifestClip('searching'),
  working: manifestClip('working'),
  sleeping: manifestClip('sleeping'),
  error: manifestClip('idle'),
  offline: manifestClip('sleeping'),
  notification: manifestClip('idle'),
  'turn-to-user': manifestClip('turn-to-user'),
  'facing-user': manifestClip('facing-user'),
  dragging: manifestClip('dragging'),
  'drop-landing': manifestClip('drop-landing'),
  appearing: manifestClip('appearing'),
  disappearing: manifestClip('disappearing'),
};

/** frame = floor(elapsedSeconds x fps); loops wrap, one-shots hold their final frame. */
export function clipFrameAt(clip: RobotClip, elapsedMs: number): number {
  const frame = Math.floor((Math.max(0, elapsedMs) * clip.fps) / 1000);
  return clip.loop ? frame % clip.frameCount : Math.min(frame, clip.frameCount - 1);
}

/** A one-shot is complete once its manifest duration has elapsed (its final frame shown for its interval). */
export const clipDone = (clip: RobotClip, elapsedMs: number): boolean => !clip.loop && elapsedMs >= clip.durationMs;

// ---------------------------------------------------------------------------
// Presentation states: visual-only poses around the chat popup (not agent runtime states).
//
//   normal (idle/walking) -> turningToUser -> facingUser -> turningAway -> normal
//
// A turn plays turn-to-user forward (opening) or backward (closing), timed from `since`; changing your mind
// mid-turn reverses from the frame currently shown, so orientation never snaps.
// ---------------------------------------------------------------------------

export type PresentationMode = 'normal' | 'turningToUser' | 'facingUser' | 'turningAway';
/** `frame` is where the current turn started and `since` when (widget clock ms); other modes ignore both. */
export type Presentation = { mode: PresentationMode; frame: number; since: number };

const TURN_CLIP = ROBOT_CLIPS['turn-to-user'];
export const TURN_FRAME_COUNT = TURN_CLIP.frameCount;
/** One turn frame at the turn's fps (30 FPS: ~33 ms). */
export const TURN_FRAME_MS = 1000 / TURN_CLIP.fps;
export const NORMAL_PRESENTATION: Presentation = { mode: 'normal', frame: 0, since: 0 };
const LAST_TURN_FRAME = TURN_FRAME_COUNT - 1;

export const isTurning = (p: Presentation): boolean => p.mode === 'turningToUser' || p.mode === 'turningAway';

/** The turn frame showing at `now`. */
export function turnFrameAt(p: Presentation, now: number): number {
  const steps = Math.floor((Math.max(0, now - p.since) * TURN_CLIP.fps) / 1000);
  if (p.mode === 'turningToUser') return Math.min(LAST_TURN_FRAME, p.frame + steps);
  if (p.mode === 'turningAway') return Math.max(0, p.frame - steps);
  return p.mode === 'facingUser' ? LAST_TURN_FRAME : 0;
}

/** When the current turn has shown its last frame for one frame interval. */
export function turnEndsAt(p: Presentation): number {
  if (p.mode === 'turningToUser') return p.since + ((LAST_TURN_FRAME - p.frame + 1) * 1000) / TURN_CLIP.fps;
  if (p.mode === 'turningAway') return p.since + ((p.frame + 1) * 1000) / TURN_CLIP.fps;
  return Number.POSITIVE_INFINITY;
}

/** The chat popup opened or closed. Reduced motion skips the turn (a short crossfade is drawn instead). */
export function presentationOnChatChange(
  p: Presentation,
  open: boolean,
  reduceMotion: boolean,
  now: number
): Presentation {
  if (reduceMotion) return open ? { mode: 'facingUser', frame: LAST_TURN_FRAME, since: now } : NORMAL_PRESENTATION;
  if (open) {
    if (p.mode === 'normal') return { mode: 'turningToUser', frame: 0, since: now };
    if (p.mode === 'turningAway') return { mode: 'turningToUser', frame: turnFrameAt(p, now), since: now };
    return p;
  }
  if (p.mode === 'facingUser') return { mode: 'turningAway', frame: LAST_TURN_FRAME, since: now };
  if (p.mode === 'turningToUser') return { mode: 'turningAway', frame: turnFrameAt(p, now), since: now };
  return p;
}

/** Finish a turn whose time is up: facing the user after turning to them, back to normal after turning away. */
export function presentationAdvance(p: Presentation, now: number): Presentation {
  if (!isTurning(p) || now < turnEndsAt(p)) return p;
  return p.mode === 'turningToUser' ? { mode: 'facingUser', frame: LAST_TURN_FRAME, since: now } : NORMAL_PRESENTATION;
}

/** Runtime work that outranks the neutral front-facing loop while the chat is open. */
const OUTRANKS_FACING: ReadonlySet<AgentAnimationState> = new Set([
  'error',
  'offline',
  'listening',
  'talking',
  'searching',
  'working',
  'thinking',
]);

/** Interaction poses that override everything the agent is doing, for as long as they last. */
export type RobotInteraction = {
  /** Lifecycle animation playing (main asked for it); 'pending' holds the first appearing frame before showing. */
  lifecycle: AgentWidgetLifecycleAnimation | 'pending' | null;
  dragPhase: AgentWidgetDragPhase;
};

export const NO_INTERACTION: RobotInteraction = { lifecycle: null, dragPhase: 'none' };

/** What the robot draws. */
export type RobotVisual = {
  strip: RobotStrip;
  /** A held frame; null plays the clip (from when it started) or, with `turn`, the turn timeline. */
  frame: number | null;
  /** The turn being played (turn-to-user forward or backward). */
  turn?: Presentation;
  /** Reduced motion: a short fade replaces appearing/disappearing. */
  fade?: 'in' | 'out';
  mirrored: boolean;
  hopping: boolean;
  /** Waiting on the user: same animation, but the robot looks left and right in a hurry. */
  panicking: boolean;
};

/**
 * One priority for everything the robot can show:
 *   disappearing > appearing > dragging > dropLanding > turningToUser > error > offline > listening > talking >
 *   searching > working > thinking > facingUser > sleeping > idle
 * Interaction poses are visual only: the runtime state keeps updating underneath and shows again when they end.
 * While the chat is open the bot faces the user (never mirrored, never hopping) unless runtime work outranks it.
 * Otherwise the runtime animation plays, mirrored when last moving left, hopping only while walking idle.
 */
export function resolveRobotVisual(
  p: Presentation,
  state: AgentAnimationState,
  opts: {
    facing: 'left' | 'right';
    moving: boolean;
    reduceMotion: boolean;
    awaitingUser?: boolean;
    interaction?: RobotInteraction;
  }
): RobotVisual {
  const still = { mirrored: false, hopping: false, panicking: false };
  const { lifecycle, dragPhase } = opts.interaction ?? NO_INTERACTION;
  const rm = opts.reduceMotion;
  if (lifecycle === 'disappearing') {
    return { strip: 'disappearing', frame: rm ? 0 : null, fade: rm ? 'out' : undefined, ...still };
  }
  if (lifecycle === 'pending') return { strip: 'appearing', frame: 0, ...still };
  if (lifecycle === 'appearing') {
    const last = ROBOT_CLIPS.appearing.frameCount - 1;
    return { strip: 'appearing', frame: rm ? last : null, fade: rm ? 'in' : undefined, ...still };
  }
  if (dragPhase === 'dragging') {
    return { strip: 'dragging', frame: rm ? 0 : null, ...still, mirrored: opts.facing === 'left' };
  }
  if (dragPhase === 'landing')
    return { strip: 'drop-landing', frame: null, ...still, mirrored: opts.facing === 'left' };
  if (isTurning(p)) return { strip: 'turn-to-user', frame: null, turn: p, ...still };
  // Reduce motion holds the first frame of every loop (the existing "still" pose).
  const loopFrame = rm ? 0 : null;
  if (p.mode === 'facingUser') {
    return { strip: OUTRANKS_FACING.has(state) ? state : 'facing-user', frame: loopFrame, ...still };
  }
  // Blocked on the user (chat closed): keep the current animation, but flip left/right as if panicking.
  const panicking = Boolean(opts.awaitingUser) && !rm;
  return {
    strip: state,
    frame: loopFrame,
    mirrored: opts.facing === 'left',
    hopping: !panicking && opts.moving && state === 'idle' && !rm,
    panicking,
  };
}
