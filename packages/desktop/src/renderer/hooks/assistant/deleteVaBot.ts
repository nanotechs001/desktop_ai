/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Deleting a VA Bot cleanly: what the warning counts, and the ordered delete itself. Order matters: the
 * bot row goes last, so any earlier failure leaves a bot the user can retry on.
 */

import { ipcBridge } from '@/common';
import { httpRequest } from '@/common/adapter/httpBridge';
import { configService } from '@/common/config/configService';
import type { ICronJob } from '@/common/adapter/ipcBridge';
import type { IChannelAssistantBindingRead } from '@/common/types/channel/channel';
import type { AgentWidgetRobot } from '@/common/types/agent/agentWidget';
import { forgetBotColor } from '@/renderer/hooks/agent/useBotColor';
import { persistEnginePin, reloadEnginePins } from '@/renderer/hooks/agent/useDefaultEngine';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { collectBotChats, removeChats, type RemoveChatsOptions } from './botChats';

/** The platforms the backend can bind a bot to, with the names shown to the user. */
const CHANNEL_PLATFORMS = [
  { id: 'telegram', label: 'Telegram' },
  { id: 'lark', label: 'Lark' },
  { id: 'dingtalk', label: 'DingTalk' },
  { id: 'weixin', label: 'WeChat' },
  { id: 'slack', label: 'Slack' },
  { id: 'discord', label: 'Discord' },
] as const;

/** What a delete takes with the bot. Zero or false means the warning hides that line. */
export type DeletePreview = { chats: number; tasks: number; hasRobot: boolean; channels: string[] };

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Tasks that run this bot, or that live in one of its chats (the backend would orphan those). */
const botJobs = async (agentId: string, chatIds: ReadonlySet<string>): Promise<ICronJob[]> => {
  const jobs = await ipcBridge.cron.listJobs.invoke();
  return jobs.filter((job) => {
    const config = job.metadata.agent_config;
    return (
      config?.assistant_id === agentId ||
      config?.custom_agent_id === agentId ||
      chatIds.has(job.metadata.conversation_id)
    );
  });
};

const bindingKey = (platform: string): string => `assistant.${platform}.agent`;

/**
 * Platforms whose stored binding names this bot. Only the stored client setting counts: `getPlatformSettings`
 * answers with the default bot when nothing is bound, which would list platforms the user never set up.
 * Unreadable settings are logged and mean "none".
 */
const boundPlatforms = async (agentId: string): Promise<(typeof CHANNEL_PLATFORMS)[number][]> => {
  try {
    const keys = CHANNEL_PLATFORMS.map((platform) => bindingKey(platform.id)).join(',');
    const settings = await httpRequest<Record<string, unknown> | undefined>('GET', `/api/settings/client?keys=${keys}`);
    return CHANNEL_PLATFORMS.filter((platform) => {
      const binding = settings?.[bindingKey(platform.id)] as IChannelAssistantBindingRead | string | null | undefined;
      return (
        typeof binding === 'object' &&
        binding !== null &&
        (binding.assistant_id === agentId || binding.custom_agent_id === agentId)
      );
    });
  } catch (error) {
    console.warn('[deleteVaBot] could not read the channel bindings:', error);
    return [];
  }
};

/** Real counts for the warning. Chats and tasks must be right, so a failure to read them fails the preview. */
export async function previewVaBotDelete(agentId: string): Promise<DeletePreview> {
  const chats = await collectBotChats(agentId);
  const chatIds = new Set(chats.map((chat) => chat.id));
  const [jobs, robots, platforms] = await Promise.all([
    botJobs(agentId, chatIds),
    // Robots live in the desktop app; the WebUI cannot reach them (a desktop-only call is never answered there).
    isElectronDesktop()
      ? ipcBridge.agentWidget.listRobots.invoke().catch((error: unknown): AgentWidgetRobot[] => {
          console.warn('[deleteVaBot] could not list the robots:', error);
          return [];
        })
      : Promise.resolve<AgentWidgetRobot[]>([]),
    boundPlatforms(agentId),
  ]);
  return {
    chats: chats.length,
    tasks: jobs.length,
    hasRobot: robots.some((robot) => robot.agent_id === agentId || chatIds.has(robot.conversation_id)),
    channels: platforms.map((platform) => platform.label),
  };
}

/** Removes the robots whose `agent_id` is this bot. Failures are only logged. */
const removeBotRobots = async (agentId: string): Promise<void> => {
  if (!isElectronDesktop()) return;
  try {
    const robots = await ipcBridge.agentWidget.listRobots.invoke();
    await Promise.all(
      robots
        .filter((robot) => robot.agent_id === agentId)
        .map((robot) =>
          ipcBridge.agentWidget.remove
            .invoke({ conversation_id: robot.conversation_id })
            .catch((error: unknown) => console.warn('[deleteVaBot] could not remove a robot:', error))
        )
    );
  } catch (error) {
    console.warn('[deleteVaBot] could not list the robots:', error);
  }
};

/** Clearing deletes the stored binding (a null client preference), which makes the platform fall back to the default Agent. */
const clearBinding = async (platform: string): Promise<void> => {
  await httpRequest<void>('PUT', '/api/settings/client', { [bindingKey(platform)]: null });
  // The platform's running sessions still hold the old bot; setAssistantSetting does this too.
  await ipcBridge.channel.syncChannelSettings.invoke({ platform });
};

/** Runs a desktop-only removal; a refusal or a failure is only logged. */
const removeOnDesktop = async (
  remove: () => Promise<{ success: boolean; msg?: string }>,
  what: string
): Promise<void> => {
  // shortcut: on the WebUI the notebook and memory stay on the desktop's disk, upgrade with an HTTP path or a desktop sweep.
  if (!isElectronDesktop()) return;
  const reply = await remove().catch((error: unknown) => ({ success: false, msg: errorMessage(error) }));
  if (!reply.success) console.warn(`[deleteVaBot] could not remove the deleted Agent ${what}:`, reply.msg);
};

/**
 * After a bot is deleted: drop its notebook (and main's cached chats of it), its memory vault (moved to the memory
 * trash), its engine pin, its color and the "last picked" memory. Failures are logged only: the bot is already gone,
 * and these are never read again.
 */
const forgetDeletedAgent = async (agentId: string): Promise<void> => {
  await removeOnDesktop(() => ipcBridge.agentNotes.removeAgent.invoke({ agentId }), 'notebook');
  await removeOnDesktop(() => ipcBridge.agentMemory.removeAgent.invoke({ agentId }), 'memory');
  // Only when pinned: writing an empty record would skip the first-run pin seeding.
  await reloadEnginePins();
  if (configService.get('agent.enginePins')?.[agentId]) {
    await persistEnginePin(agentId, null).catch((error: unknown) =>
      console.warn('[deleteVaBot] could not drop the deleted Agent engine pin:', error)
    );
  }
  await forgetBotColor(agentId).catch((error: unknown) =>
    console.warn('[deleteVaBot] could not drop the deleted Agent color:', error)
  );
  if (configService.get('guid.lastAssistantId') === agentId) {
    await configService
      .remove('guid.lastAssistantId')
      .catch((error: unknown) => console.warn('[deleteVaBot] could not clear the last picked Agent:', error));
  }
};

/** Why a delete stopped. Everything but `bot` leaves the bot in place; `bot` means earlier steps already ran. */
export type DeleteVaBotOutcome =
  | { ok: true }
  | { ok: false; stage: 'profile' | 'chatsList' | 'cron' }
  | { ok: false; stage: 'chats'; failed: number; total: number }
  | { ok: false; stage: 'bot'; error: unknown };

/**
 * Deletes the bot and everything it owns, in order: browser profile, chats, scheduled tasks, channel bindings,
 * then the bot. The first three stop the whole delete when they fail; channel bindings never block it.
 */
export async function deleteVaBot(
  agentId: string,
  { onProgress, onChatRemoved }: { onProgress?: RemoveChatsOptions['onProgress']; onChatRemoved?: (id: string) => void }
): Promise<DeleteVaBotOutcome> {
  // 1. Browser profile, kept by the desktop app.
  // shortcut: on the WebUI the profile stays on the desktop's disk, upgrade with an HTTP path or a desktop sweep.
  const profile = isElectronDesktop()
    ? await ipcBridge.browser.deleteProfileData
        .invoke({ agentId })
        .catch((error: unknown) => ({ success: false, msg: errorMessage(error) }))
    : { success: true };
  if (!profile.success) {
    console.warn('[deleteVaBot] could not delete the Agent browser data:', profile.msg);
    return { ok: false, stage: 'profile' };
  }

  // 2. Chats
  let chats: Awaited<ReturnType<typeof collectBotChats>>;
  try {
    chats = await collectBotChats(agentId);
  } catch (error) {
    console.warn('[deleteVaBot] could not list the Agent chats:', error);
    return { ok: false, stage: 'chatsList' };
  }
  const removal = await removeChats(chats, { onProgress, onRemoved: onChatRemoved });
  if (removal.failed.length > 0) {
    return { ok: false, stage: 'chats', failed: removal.failed.length, total: chats.length };
  }

  // Robots of this bot that no chat accounted for (idempotent; the chats' own removals already dropped theirs).
  await removeBotRobots(agentId);

  // 3. Scheduled tasks
  try {
    const jobs = await botJobs(agentId, new Set(chats.map((chat) => chat.id)));
    const results = await Promise.allSettled(jobs.map((job) => ipcBridge.cron.removeJob.invoke({ job_id: job.id })));
    if (results.some((result) => result.status === 'rejected')) throw new Error('a scheduled task was not removed');
  } catch (error) {
    console.warn('[deleteVaBot] could not remove the Agent scheduled tasks:', error);
    return { ok: false, stage: 'cron' };
  }

  // 4. Channel bindings: the warning already told the user, so a failure is only logged.
  try {
    const platforms = await boundPlatforms(agentId);
    await Promise.all(
      platforms.map((platform) =>
        clearBinding(platform.id).catch((error: unknown) =>
          console.warn(`[deleteVaBot] could not clear the ${platform.id} binding:`, error)
        )
      )
    );
  } catch (error) {
    console.warn('[deleteVaBot] could not clear the channel bindings:', error);
  }

  // 5. The bot itself, then what the app remembered about it
  try {
    await ipcBridge.assistants.delete.invoke({ id: agentId });
  } catch (error) {
    console.error('Failed to delete assistant:', error);
    return { ok: false, stage: 'bot', error };
  }
  await forgetDeletedAgent(agentId);
  return { ok: true };
}
