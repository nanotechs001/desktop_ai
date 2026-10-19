/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The ordered delete of a VA Bot (profile, chats, tasks, channel bindings, the bot) and the preview that
 * counts what it takes with it. This deletes user data: every step's failure path is covered.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  calls: [] as string[],
  deleteProfileData: vi.fn(),
  assistantsDelete: vi.fn(),
  removeAgentNotes: vi.fn(),
  listJobs: vi.fn(),
  removeJob: vi.fn(),
  getPlatformSettings: vi.fn(),
  syncChannelSettings: vi.fn(),
  listRobots: vi.fn(),
  httpRequest: vi.fn(),
  collectBotChats: vi.fn(),
  removeChats: vi.fn(),
  forgetBotColor: vi.fn(),
  persistEnginePin: vi.fn(),
  config: new Map<string, unknown>(),
  configRemove: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    browser: { deleteProfileData: { invoke: (...a: unknown[]) => m.deleteProfileData(...a) } },
    assistants: { delete: { invoke: (...a: unknown[]) => m.assistantsDelete(...a) } },
    agentNotes: { removeAgent: { invoke: (...a: unknown[]) => m.removeAgentNotes(...a) } },
    cron: {
      listJobs: { invoke: (...a: unknown[]) => m.listJobs(...a) },
      removeJob: { invoke: (...a: unknown[]) => m.removeJob(...a) },
    },
    channel: {
      getPlatformSettings: { invoke: (...a: unknown[]) => m.getPlatformSettings(...a) },
      syncChannelSettings: { invoke: (...a: unknown[]) => m.syncChannelSettings(...a) },
    },
    agentWidget: { listRobots: { invoke: (...a: unknown[]) => m.listRobots(...a) } },
  },
}));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: (...a: unknown[]) => m.httpRequest(...a) }));
vi.mock('@/renderer/hooks/assistant/botChats', () => ({
  collectBotChats: (...a: unknown[]) => m.collectBotChats(...a),
  removeChats: (...a: unknown[]) => m.removeChats(...a),
}));
vi.mock('@/renderer/hooks/agent/useBotColor', () => ({ forgetBotColor: (...a: unknown[]) => m.forgetBotColor(...a) }));
vi.mock('@/renderer/hooks/agent/useDefaultEngine', () => ({
  persistEnginePin: (...a: unknown[]) => m.persistEnginePin(...a),
}));
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (key: string) => m.config.get(key),
    remove: (...a: unknown[]) => m.configRemove(...a),
  },
}));

import { deleteVaBot, previewVaBotDelete } from '@/renderer/hooks/assistant/deleteVaBot';

const BOT = 'bare:gone';
const chat = (id: string) => ({ id, name: id, assistant: { id: BOT } });
const job = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  metadata: { conversation_id: `cron-conv-${id}`, ...extra },
});
const noBinding = { platform: 'x', assistant: null, default_model: null };

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.config.clear();
  m.deleteProfileData.mockImplementation(async () => (m.calls.push('profile'), { success: true }));
  m.collectBotChats.mockImplementation(async () => (m.calls.push('collect'), [chat('c1'), chat('c2')]));
  m.removeChats.mockImplementation(
    async (list: { id: string }[]) => (m.calls.push('removeChats'), { removed: list.map((c) => c.id), failed: [] })
  );
  m.listJobs.mockImplementation(async () => (m.calls.push('listJobs'), []));
  m.removeJob.mockImplementation(async () => (m.calls.push('removeJob'), undefined));
  m.getPlatformSettings.mockImplementation(async () => (m.calls.push('getPlatformSettings'), noBinding));
  m.httpRequest.mockImplementation(async () => (m.calls.push('clearBinding'), undefined));
  m.syncChannelSettings.mockResolvedValue(undefined);
  m.assistantsDelete.mockImplementation(async () => (m.calls.push('deleteBot'), undefined));
  m.removeAgentNotes.mockImplementation(async () => (m.calls.push('forget'), { success: true }));
  m.persistEnginePin.mockResolvedValue(undefined);
  m.forgetBotColor.mockResolvedValue(undefined);
  m.configRemove.mockResolvedValue(undefined);
  m.listRobots.mockResolvedValue([]);
});

describe('deleteVaBot', () => {
  it('runs the steps in order: profile, chats, tasks, channel bindings, the bot, then what it remembered', async () => {
    m.listJobs.mockImplementation(
      async () => (m.calls.push('listJobs'), [job('j1', { agent_config: { assistant_id: BOT } })])
    );
    m.getPlatformSettings.mockImplementation(async ({ platform }: { platform: string }) => {
      m.calls.push('getPlatformSettings');
      return platform === 'slack' ? { ...noBinding, assistant: { assistant_id: BOT } } : noBinding;
    });

    const outcome = await deleteVaBot(BOT, {});

    expect(outcome).toEqual({ ok: true });
    const firstOf = (name: string) => m.calls.indexOf(name);
    const order = [
      'profile',
      'collect',
      'removeChats',
      'listJobs',
      'removeJob',
      'getPlatformSettings',
      'clearBinding',
      'deleteBot',
      'forget',
    ];
    expect(order.map(firstOf)).toEqual(
      order
        .map(firstOf)
        .slice()
        .sort((a, b) => a - b)
    );
    expect(order.every((name) => firstOf(name) >= 0)).toBe(true);
    expect(m.deleteProfileData).toHaveBeenCalledWith({ agentId: BOT });
    expect(m.assistantsDelete).toHaveBeenCalledWith({ id: BOT });
  });

  describe('browser profile', () => {
    it.each([
      ['refuses', () => m.deleteProfileData.mockResolvedValue({ success: false, msg: 'busy' })],
      ['rejects', () => m.deleteProfileData.mockRejectedValue(new Error('ipc down'))],
    ])('keeps everything when the profile delete %s', async (_name, arrange) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      arrange();

      const outcome = await deleteVaBot(BOT, {});

      expect(outcome).toEqual({ ok: false, stage: 'profile' });
      expect(m.collectBotChats).not.toHaveBeenCalled();
      expect(m.removeChats).not.toHaveBeenCalled();
      expect(m.listJobs).not.toHaveBeenCalled();
      expect(m.httpRequest).not.toHaveBeenCalled();
      expect(m.assistantsDelete).not.toHaveBeenCalled();
      expect(m.removeAgentNotes).not.toHaveBeenCalled();
    });
  });

  describe('chats', () => {
    it('removes exactly the chats it found and passes the progress and the removed-chat callbacks along', async () => {
      const onProgress = vi.fn();
      const onChatRemoved = vi.fn();

      await deleteVaBot(BOT, { onProgress, onChatRemoved });

      expect(m.removeChats).toHaveBeenCalledWith([chat('c1'), chat('c2')], {
        onProgress,
        onRemoved: onChatRemoved,
      });
    });

    it('keeps the bot, and says how many chats are left, when any chat fails', async () => {
      m.removeChats.mockResolvedValue({ removed: ['c1'], failed: ['c2'] });

      const outcome = await deleteVaBot(BOT, {});

      expect(outcome).toEqual({ ok: false, stage: 'chats', failed: 1, total: 2 });
      expect(m.assistantsDelete).not.toHaveBeenCalled();
      expect(m.removeAgentNotes).not.toHaveBeenCalled();
      expect(m.listJobs).not.toHaveBeenCalled();
      expect(m.httpRequest).not.toHaveBeenCalled();
    });

    it('keeps the bot when its chats cannot be listed completely', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      m.collectBotChats.mockRejectedValue(new Error('page failed'));

      const outcome = await deleteVaBot(BOT, {});

      expect(outcome).toEqual({ ok: false, stage: 'chatsList' });
      expect(m.removeChats).not.toHaveBeenCalled();
      expect(m.assistantsDelete).not.toHaveBeenCalled();
    });

    it('does not touch the chat removal when the bot has no chats', async () => {
      m.collectBotChats.mockResolvedValue([]);
      expect(await deleteVaBot(BOT, {})).toEqual({ ok: true });
      expect(m.assistantsDelete).toHaveBeenCalled();
    });
  });

  describe('scheduled tasks', () => {
    it('removes the tasks that run this bot (assistant_id or the legacy custom_agent_id) and no others', async () => {
      m.listJobs.mockResolvedValue([
        job('mine', { agent_config: { assistant_id: BOT } }),
        job('legacy', { agent_config: { custom_agent_id: BOT } }),
        job('other-bot', { agent_config: { assistant_id: 'someone-else' } }),
        job('plain'),
        job('in-its-chat', { conversation_id: 'c1' }),
      ]);

      await deleteVaBot(BOT, {});

      const removed = m.removeJob.mock.calls.map(([arg]) => arg.job_id).toSorted();
      expect(removed).toEqual(['in-its-chat', 'legacy', 'mine']);
    });

    it.each([
      ['the list fails', () => m.listJobs.mockRejectedValue(new Error('down'))],
      [
        'a removal fails',
        () => {
          m.listJobs.mockResolvedValue([job('a', { agent_config: { assistant_id: BOT } })]);
          m.removeJob.mockRejectedValue(new Error('down'));
        },
      ],
    ])('keeps the bot when %s', async (_name, arrange) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      arrange();

      const outcome = await deleteVaBot(BOT, {});

      expect(outcome).toEqual({ ok: false, stage: 'cron' });
      expect(m.assistantsDelete).not.toHaveBeenCalled();
      expect(m.httpRequest).not.toHaveBeenCalled();
    });
  });

  describe('channel bindings', () => {
    const boundTo = (...platforms: string[]) =>
      m.getPlatformSettings.mockImplementation(async ({ platform }: { platform: string }) => ({
        ...noBinding,
        assistant: platforms.includes(platform) ? { assistant_id: BOT } : { assistant_id: 'someone-else' },
      }));

    it('clears the binding of each platform that points at this bot and no other, then resets that platform', async () => {
      boundTo('telegram', 'slack');

      await deleteVaBot(BOT, {});

      expect(m.httpRequest).toHaveBeenCalledTimes(2);
      expect(m.httpRequest).toHaveBeenCalledWith('PUT', '/api/settings/client', { 'assistant.telegram.agent': null });
      expect(m.httpRequest).toHaveBeenCalledWith('PUT', '/api/settings/client', { 'assistant.slack.agent': null });
      expect(m.syncChannelSettings).toHaveBeenCalledWith({ platform: 'telegram' });
      expect(m.syncChannelSettings).toHaveBeenCalledWith({ platform: 'slack' });
    });

    it('also clears a legacy binding that names the bot by custom_agent_id', async () => {
      m.getPlatformSettings.mockImplementation(async ({ platform }: { platform: string }) => ({
        ...noBinding,
        assistant: platform === 'discord' ? { custom_agent_id: BOT } : null,
      }));
      await deleteVaBot(BOT, {});
      expect(m.httpRequest).toHaveBeenCalledWith('PUT', '/api/settings/client', { 'assistant.discord.agent': null });
    });

    it('still deletes the bot when a binding cannot be read or cleared (logged, not blocking)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      m.getPlatformSettings.mockImplementation(async ({ platform }: { platform: string }) => {
        if (platform === 'lark') throw new Error('read failed');
        return { ...noBinding, assistant: platform === 'slack' ? { assistant_id: BOT } : null };
      });
      m.httpRequest.mockRejectedValue(new Error('write failed'));

      const outcome = await deleteVaBot(BOT, {});

      expect(outcome).toEqual({ ok: true });
      expect(m.assistantsDelete).toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('the bot itself', () => {
    it('reports a bot-delete failure after the earlier steps succeeded, and forgets nothing', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      m.assistantsDelete.mockRejectedValue(new Error('backend down'));

      const outcome = await deleteVaBot(BOT, {});

      expect(outcome).toMatchObject({ ok: false, stage: 'bot' });
      expect(m.removeAgentNotes).not.toHaveBeenCalled();
      expect(m.configRemove).not.toHaveBeenCalled();
    });

    it('forgets its notebook, engine pin and color after the delete', async () => {
      m.config.set('agent.enginePins', { [BOT]: 'engine-x' });

      await deleteVaBot(BOT, {});

      expect(m.removeAgentNotes).toHaveBeenCalledWith({ agentId: BOT });
      expect(m.persistEnginePin).toHaveBeenCalledWith(BOT, null);
      expect(m.forgetBotColor).toHaveBeenCalledWith(BOT);
    });

    it('clears the "last picked bot" only when it was this one', async () => {
      m.config.set('guid.lastAssistantId', BOT);
      await deleteVaBot(BOT, {});
      expect(m.configRemove).toHaveBeenCalledWith('guid.lastAssistantId');

      m.configRemove.mockClear();
      m.config.set('guid.lastAssistantId', 'someone-else');
      await deleteVaBot(BOT, {});
      expect(m.configRemove).not.toHaveBeenCalled();
    });

    it('still succeeds when forgetting its notebook or the last-picked clear fails (the bot is already gone)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      m.config.set('guid.lastAssistantId', BOT);
      m.removeAgentNotes.mockRejectedValue(new Error('x'));
      m.configRemove.mockRejectedValue(new Error('y'));

      expect(await deleteVaBot(BOT, {})).toEqual({ ok: true });
    });
  });
});

describe('previewVaBotDelete', () => {
  it('counts the chats, tasks, robot and bound channels, with names for the channels', async () => {
    m.listJobs.mockResolvedValue([
      job('a', { agent_config: { assistant_id: BOT } }),
      job('b', { conversation_id: 'c2' }),
      job('c', { agent_config: { assistant_id: 'other' } }),
    ]);
    m.listRobots.mockResolvedValue([{ conversation_id: 'zzz', agent_id: BOT, hidden: false }]);
    m.getPlatformSettings.mockImplementation(async ({ platform }: { platform: string }) => ({
      ...noBinding,
      assistant: platform === 'dingtalk' || platform === 'telegram' ? { assistant_id: BOT } : null,
    }));

    const preview = await previewVaBotDelete(BOT);

    expect(preview).toEqual({ chats: 2, tasks: 2, hasRobot: true, channels: ['Telegram', 'DingTalk'] });
    expect(m.deleteProfileData).not.toHaveBeenCalled();
    expect(m.removeChats).not.toHaveBeenCalled();
  });

  it('reports zeros (so the lines are hidden) when the bot owns nothing', async () => {
    m.collectBotChats.mockResolvedValue([]);
    expect(await previewVaBotDelete(BOT)).toEqual({ chats: 0, tasks: 0, hasRobot: false, channels: [] });
  });

  it('finds a robot by one of the bot chats, hidden or not', async () => {
    m.listRobots.mockResolvedValue([{ conversation_id: 'c2', hidden: true }]);
    expect((await previewVaBotDelete(BOT)).hasRobot).toBe(true);
  });

  it('fails (rather than showing a wrong count) when chats or tasks cannot be read', async () => {
    m.collectBotChats.mockRejectedValueOnce(new Error('x'));
    await expect(previewVaBotDelete(BOT)).rejects.toThrow();
    m.listJobs.mockRejectedValueOnce(new Error('x'));
    await expect(previewVaBotDelete(BOT)).rejects.toThrow();
  });

  it('still previews when the robots or a channel cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.listRobots.mockRejectedValue(new Error('x'));
    m.getPlatformSettings.mockRejectedValue(new Error('x'));
    expect(await previewVaBotDelete(BOT)).toEqual({ chats: 2, tasks: 0, hasRobot: false, channels: [] });
  });
});
