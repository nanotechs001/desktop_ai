/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import {
  CONVERSATION_ID_PATTERN,
  DEFAULT_AGENT_WIDGET_SETTINGS,
  MAX_WIDGET_SCALE,
  MIN_WIDGET_SCALE,
  type AgentWidgetPersistedState,
  type AgentWidgetRecord,
  type AgentWidgetSettings,
} from '@/common/types/agent/agentWidget';

/**
 * Widget preferences + conversation↔widget mapping, persisted under the
 * `agentWidget` ProcessConfig key. Only layout/UI state lives here; chat,
 * memory and runtime state stay in aioncore.
 */

export const settingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    autoLaunch: z.boolean(),
    autonomousMovement: z.boolean(),
    movementFrequency: z.enum(['low', 'medium', 'high']),
    scale: z.number().finite(),
    alwaysOnTop: z.boolean(),
    reduceMotion: z.boolean(),
    muteVoice: z.boolean(),
  })
  .partial()
  .strict();

const recordSchema = z.object({
  widget_id: z.string().min(1).max(128),
  conversation_id: z.string().regex(CONVERSATION_ID_PATTERN),
  display_id: z.number().finite().optional(),
  x_ratio: z.number().min(0).max(1).optional(),
  expanded: z.boolean(),
  hidden: z.boolean(),
  chat_location: z.enum(['main', 'widget']),
  agent_id: z.string().min(1).max(256).optional(),
  modified_at: z.number().finite().optional(),
  window_mode: z.enum(['compact', 'expanded']).optional(),
  expanded_bounds: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    })
    .strict()
    // Older builds saved fractional bounds, which no window accepts.
    .transform((b) => ({
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
    }))
    .optional(),
});

export const clampScale = (scale: number): number => Math.min(MAX_WIDGET_SCALE, Math.max(MIN_WIDGET_SCALE, scale));

export function mergeSettings(base: AgentWidgetSettings, patch: unknown): AgentWidgetSettings {
  const parsed = settingsPatchSchema.safeParse(patch);
  const merged = { ...base, ...(parsed.success ? parsed.data : {}) };
  return { ...merged, scale: clampScale(merged.scale) };
}

function pickKnownSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const known = Object.keys(DEFAULT_AGENT_WIDGET_SETTINGS);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    // Drop keys from older versions and any field whose type no longer matches.
    if (known.includes(k) && settingsPatchSchema.safeParse({ [k]: v }).success) result[k] = v;
  }
  return result;
}

/**
 * Coerce whatever is on disk into a valid state: unknown/invalid records are
 * dropped, settings fall back to defaults field by field. Popups never restore
 * expanded — a desktop full of open chat bubbles on boot is worse than one click.
 */
export function normalizeWidgetState(raw: unknown): AgentWidgetPersistedState {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as { settings?: unknown; widgets?: unknown };
  const settings = mergeSettings(DEFAULT_AGENT_WIDGET_SETTINGS, pickKnownSettings(obj.settings));
  const widgets: Record<string, AgentWidgetRecord> = {};
  if (obj.widgets && typeof obj.widgets === 'object') {
    for (const value of Object.values(obj.widgets as Record<string, unknown>)) {
      const parsed = recordSchema.safeParse(value);
      // Every field is validated above; the cast only papers over zod's loose inference under this tsconfig.
      if (parsed.success)
        widgets[parsed.data.conversation_id] = { ...(parsed.data as AgentWidgetRecord), expanded: false };
    }
  }
  return { settings, widgets };
}

export type WidgetStateIO = {
  read: () => Promise<unknown>;
  write: (state: AgentWidgetPersistedState) => Promise<unknown>;
};

/** Default IO: the app's ProcessConfig JSON file. Lazy-imported so tests can inject IO without Electron. */
export const processConfigIO: WidgetStateIO = {
  read: async () => {
    const { ProcessConfig } = await import('@process/utils/initStorage');
    return ProcessConfig.get('agentWidget');
  },
  write: async (state) => {
    const { ProcessConfig } = await import('@process/utils/initStorage');
    return ProcessConfig.set('agentWidget', state);
  },
};
