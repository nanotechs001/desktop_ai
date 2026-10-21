/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { ipcBridge } from '@/common';
import {
  AGENT_ANIMATION_STATES,
  AGENT_WIDGET_PREVIEW_TYPES,
  AGENT_WIDGET_WINDOW_GESTURES,
  MAX_AGENT_WIDGET_PREVIEW_CHARS,
  CONVERSATION_ID_PATTERN,
  isHttpUrl,
} from '@/common/types/agent/agentWidget';
import { isBotColor } from '@/common/types/agent/botColors';
import type { AgentWidgetManager } from './agentWidgetManager';
import { settingsPatchSchema } from './agentWidgetStore';

/**
 * Every widget→main message is validated here before it reaches the manager:
 * the bridge is reachable from any renderer (and WebUI sockets), so payloads
 * are treated as untrusted. Unknown keys are rejected, not ignored.
 */

const conversationId = z.string().regex(CONVERSATION_ID_PATTERN);
const target = z.object({ conversation_id: conversationId }).strict();
const agentId = z.string().min(1).max(256);
const botColors = z.record(agentId, z.string().refine(isBotColor));
const windowOrigin = z.string().min(1).max(64);
const configNews = z
  .object({ origin: windowOrigin, entries: z.record(z.string().min(1).max(128), z.unknown()) })
  .strict();
// A pointer delta in DIP: finite, and no larger than any desktop.
const screenDelta = z.number().finite().min(-100_000).max(100_000);
const schemas = {
  ensure: target.extend({ force: z.boolean().optional(), agent_id: agentId.optional() }).strict(),
  openPopup: target.extend({ agent_id: agentId.optional() }).strict(),
  setExpanded: target.extend({ expanded: z.boolean() }).strict(),
  setWindowMode: target.extend({ mode: z.enum(['compact', 'expanded']) }).strict(),
  adjustWindow: target
    .extend({
      gesture: z.enum(AGENT_WIDGET_WINDOW_GESTURES),
      phase: z.enum(['start', 'move', 'end']),
      dx: screenDelta,
      dy: screenDelta,
    })
    .strict(),
  setChatLocation: target.extend({ location: z.enum(['main', 'widget']) }).strict(),
  handoffDraft: target.extend({ text: z.string().max(100_000) }).strict(),
  reportState: target.extend({ state: z.enum(AGENT_ANIMATION_STATES), transitioning: z.boolean().optional() }).strict(),
  setIgnoreMouse: target.extend({ ignore: z.boolean() }).strict(),
  rendererReady: target.extend({ agent_id: agentId.optional(), modified_at: z.number().finite().optional() }).strict(),
  showConversation: target.extend({ to: conversationId }).strict(),
  openAgentSettings: target.extend({ agent_id: agentId }).strict(),
  openLinkInMain: target.extend({ url: z.string().max(8192).refine(isHttpUrl) }).strict(),
  // Only the main-window pages a chat links to: engine and model settings, a scheduled task.
  openPageInMain: target
    .extend({ path: z.string().regex(/^\/(settings\/(agent|model)|scheduled\/[\w-]{1,128})$/) })
    .strict(),
  openFileInMain: target.extend({ path: z.string().min(1).max(4096) }).strict(),
  openPreviewInMain: target
    .extend({
      content: z.string().max(MAX_AGENT_WIDGET_PREVIEW_CHARS),
      content_type: z.enum(AGENT_WIDGET_PREVIEW_TYPES),
      title: z.string().max(512).optional(),
      file_name: z.string().max(512).optional(),
      language: z.string().max(64).optional(),
    })
    .strict(),
  animationDone: target.extend({ animation: z.enum(['appearing', 'disappearing']) }).strict(),
  setSuspended: target.extend({ suspended: z.boolean() }).strict(),
};

function parse<T>(schema: z.ZodType<T>, value: unknown, channel: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`[AgentWidget] rejected invalid payload on ${channel}`);
  return result.data;
}

export function initAgentWidgetBridge(manager: AgentWidgetManager): void {
  const w = ipcBridge.agentWidget;

  w.getSettings.provider(async () => manager.getSettings());
  w.setSettings.provider(async (p) => manager.setSettings(parse(settingsPatchSchema, p, 'setSettings')));
  w.ensure.provider(async (p) => {
    const { conversation_id, force, agent_id } = parse(schemas.ensure, p, 'ensure');
    return manager.ensure(conversation_id, force, agent_id);
  });
  w.hide.provider(async (p) => manager.hide(parse(target, p, 'hide').conversation_id));
  w.listHidden.provider(async () => manager.listHidden());
  w.listRobots.provider(async () => manager.listRobots());
  w.openPopup.provider(async (p) => {
    const { conversation_id, agent_id } = parse(schemas.openPopup, p, 'openPopup');
    return manager.openPopup(conversation_id, agent_id);
  });
  w.remove.provider(async (p) => manager.remove(parse(target, p, 'remove').conversation_id));
  w.getSnapshot.provider(async (p) => manager.getSnapshot(parse(target, p, 'getSnapshot').conversation_id));
  w.setExpanded.provider(async (p) => {
    const { conversation_id, expanded } = parse(schemas.setExpanded, p, 'setExpanded');
    manager.setExpanded(conversation_id, expanded);
  });
  w.setWindowMode.provider(async (p) => {
    const { conversation_id, mode } = parse(schemas.setWindowMode, p, 'setWindowMode');
    manager.setWindowMode(conversation_id, mode);
  });
  w.adjustWindow.provider(async (p) => {
    const { conversation_id, gesture, phase, dx, dy } = parse(schemas.adjustWindow, p, 'adjustWindow');
    manager.adjustWindow(conversation_id, gesture, phase, dx, dy);
  });
  w.setChatLocation.provider(async (p) => {
    const { conversation_id, location } = parse(schemas.setChatLocation, p, 'setChatLocation');
    manager.setChatLocation(conversation_id, location);
  });
  w.getChatLocations.provider(async () => manager.getChatLocations());
  w.handoffDraft.provider(async (p) => {
    const { conversation_id, text } = parse(schemas.handoffDraft, p, 'handoffDraft');
    manager.handoffDraft(conversation_id, text);
  });
  w.takeDraft.provider(async (p) => manager.takeDraft(parse(target, p, 'takeDraft').conversation_id));
  w.reportState.provider(async (p) => {
    const { conversation_id, state, transitioning } = parse(schemas.reportState, p, 'reportState');
    manager.reportState(conversation_id, state, transitioning);
  });
  w.dragStart.provider(async (p) => manager.dragStart(parse(target, p, 'dragStart').conversation_id));
  w.dragMove.provider(async (p) => manager.dragMove(parse(target, p, 'dragMove').conversation_id));
  w.dragEnd.provider(async (p) => manager.dragEnd(parse(target, p, 'dragEnd').conversation_id));
  w.landStep.provider(async (p) => manager.landStep(parse(target, p, 'landStep').conversation_id));
  w.setIgnoreMouse.provider(async (p) => {
    const { conversation_id, ignore } = parse(schemas.setIgnoreMouse, p, 'setIgnoreMouse');
    manager.setIgnoreMouse(conversation_id, ignore);
  });
  w.openInMain.provider(async (p) => manager.openInMain(parse(target, p, 'openInMain').conversation_id));
  w.openAgentSettings.provider(async (p) =>
    manager.openAgentSettings(parse(schemas.openAgentSettings, p, 'openAgentSettings').agent_id)
  );
  w.openLinkInMain.provider(async (p) => {
    const { conversation_id, url } = parse(schemas.openLinkInMain, p, 'openLinkInMain');
    manager.openLinkInMain(conversation_id, url);
  });
  w.openPageInMain.provider(async (p) => {
    const { conversation_id, path } = parse(schemas.openPageInMain, p, 'openPageInMain');
    manager.openPageInMain(conversation_id, path);
  });
  w.openFileInMain.provider(async (p) => {
    const { conversation_id, path } = parse(schemas.openFileInMain, p, 'openFileInMain');
    manager.openFileInMain(conversation_id, path);
  });
  w.openPreviewInMain.provider(async (p) => {
    const { conversation_id, content, content_type, title, file_name, language } = parse(
      schemas.openPreviewInMain,
      p,
      'openPreviewInMain'
    );
    manager.openPreviewInMain(conversation_id, { content, content_type, title, file_name, language });
  });
  w.followActivity.provider(async (p) =>
    manager.followAgentActivity(parse(target, p, 'followActivity').conversation_id)
  );
  w.watchInMain.provider(async (p) => manager.watchInMain(parse(target, p, 'watchInMain').conversation_id));
  w.followInMain.provider(async (p) => manager.followFromPopup(parse(target, p, 'followInMain').conversation_id));
  w.rendererReady.provider(async (p) => {
    const { conversation_id, agent_id, modified_at } = parse(schemas.rendererReady, p, 'rendererReady');
    manager.rendererReady(conversation_id, { agent_id, modified_at });
  });
  w.showConversation.provider(async (p) => {
    const { conversation_id, to } = parse(schemas.showConversation, p, 'showConversation');
    manager.retarget(conversation_id, to);
  });
  w.animationDone.provider(async (p) => {
    const { conversation_id, animation } = parse(schemas.animationDone, p, 'animationDone');
    manager.animationDone(conversation_id, animation);
  });
  w.broadcastBotColors.provider(async (p) => {
    w.botColorsChanged.emit(parse(botColors, p, 'broadcastBotColors'));
  });
  // Each window keeps its own settings cache: a stored change reaches the others. Main only relays it.
  w.broadcastConfig.provider(async (p) => {
    const { origin, entries } = parse(configNews, p, 'broadcastConfig');
    w.configChanged.emit({ origin, entries });
  });
  w.broadcastAssistantsChanged.provider(async (p) => {
    const { origin } = parse(z.object({ origin: windowOrigin }).strict(), p, 'broadcastAssistantsChanged');
    w.assistantsChanged.emit({ origin });
  });
  w.setSuspended.provider(async (p) => {
    const { conversation_id, suspended } = parse(schemas.setSuspended, p, 'setSuspended');
    manager.setSuspended(conversation_id, suspended);
  });
}
