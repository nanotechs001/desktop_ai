/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The once-per-start offer to delete chats left by deleted VA Bots. Nothing is deleted without the click, Keep is
 * remembered, and a failed detection shows nothing.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider, Message } from '@arco-design/web-react';

// `t` echoes the key and its values (`key|count=2`), so the tests can see which line shows and what it was told.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, options?: Record<string, unknown>) => {
      const values = Object.entries(options ?? {})
        .filter(([name]) => name !== 'defaultValue')
        .map(([name, value]) => `${name}=${String(value)}`);
      return values.length > 0 ? `${k}|${values.join(',')}` : k;
    },
    i18n: { language: 'en' },
  }),
}));

const mocks = vi.hoisted(() => ({
  findOrphanChats: vi.fn(),
  removeChats: vi.fn(),
  configGet: vi.fn(),
  configSet: vi.fn(),
  whenReady: vi.fn(),
  widgetId: vi.fn(),
  navigate: vi.fn(),
  openChatId: { value: undefined as string | undefined },
  emit: vi.fn(),
}));

vi.mock('@/renderer/hooks/assistant/botChats', () => ({
  findOrphanChats: mocks.findOrphanChats,
  removeChats: mocks.removeChats,
}));
vi.mock('@/common/config/configService', () => ({
  configService: { get: mocks.configGet, set: mocks.configSet, whenReady: mocks.whenReady },
}));
vi.mock('@/renderer/pages/agentWidget/chatLocation', () => ({ getWidgetConversationId: mocks.widgetId }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useMatch: () => (mocks.openChatId.value ? { params: { id: mocks.openChatId.value } } : null),
}));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: mocks.emit } }));

import OrphanChatsPrompt from '@/renderer/components/OrphanChatsPrompt';
import { ORPHAN_CHECK_DELAY_MS, resetOrphanCheck } from '@/renderer/hooks/assistant/useOrphanChats';
import type { TChatConversation } from '@/common/config/storage';

const chat = (id: string): TChatConversation => ({ id, name: `Chat ${id}` }) as unknown as TChatConversation;
const chats = (n: number) => Array.from({ length: n }, (_, i) => chat(`c${i + 1}`));

const mount = () =>
  render(
    <ConfigProvider>
      <OrphanChatsPrompt />
    </ConfigProvider>
  );
/** Lets the startup delay pass and the background detection settle. */
const startDetection = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ORPHAN_CHECK_DELAY_MS);
  });
};
/** Lets Arco's close animation finish. */
const closeAnimation = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
const keepButton = () => screen.getByRole('button', { name: 'agent.orphanChats.keep' });
const deleteButton = () => screen.getByRole('button', { name: 'common.delete' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetOrphanCheck();
  mocks.widgetId.mockReturnValue(null);
  mocks.openChatId.value = undefined;
  mocks.configGet.mockReturnValue(undefined);
  mocks.configSet.mockResolvedValue(undefined);
  mocks.whenReady.mockResolvedValue(undefined);
  mocks.findOrphanChats.mockResolvedValue([]);
  mocks.removeChats.mockImplementation(async (list: TChatConversation[]) => ({
    removed: list.map((c) => c.id),
    failed: [],
  }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OrphanChatsPrompt', () => {
  it('looks in the background after the startup delay, not at mount', async () => {
    mount();
    expect(mocks.findOrphanChats).not.toHaveBeenCalled();

    await startDetection();

    expect(mocks.findOrphanChats).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when there are no orphans', async () => {
    mount();
    await startDetection();

    expect(screen.queryByRole('button', { name: 'agent.orphanChats.keep' })).not.toBeInTheDocument();
  });

  it('shows the count, up to five names and "and N more"', async () => {
    mocks.findOrphanChats.mockResolvedValue(chats(7));
    mount();
    await startDetection();

    expect(screen.getByText('agent.orphanChats.title|count=7')).toBeInTheDocument();
    for (const name of ['Chat c1', 'Chat c2', 'Chat c3', 'Chat c4', 'Chat c5']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.queryByText('Chat c6')).not.toBeInTheDocument();
    expect(screen.getByText('agent.orphanChats.more|count=2')).toBeInTheDocument();
  });

  it('lists every name and no "more" line for five or fewer', async () => {
    mocks.findOrphanChats.mockResolvedValue(chats(2));
    mount();
    await startDetection();

    expect(screen.getByText('Chat c2')).toBeInTheDocument();
    expect(screen.queryByText(/agent\.orphanChats\.more/)).not.toBeInTheDocument();
  });

  it('shows nothing when the detection fails, and only logs', async () => {
    mocks.findOrphanChats.mockRejectedValue(new Error('offline'));
    mount();
    await startDetection();

    expect(screen.queryByRole('button', { name: 'agent.orphanChats.keep' })).not.toBeInTheDocument();
    expect(console.warn).toHaveBeenCalled();
  });

  it('never looks in a widget window', async () => {
    mocks.widgetId.mockReturnValue('conv-1');
    mount();
    await startDetection();

    expect(mocks.findOrphanChats).not.toHaveBeenCalled();
  });

  it('asks once per app start, even when the prompt mounts again', async () => {
    const first = mount();
    await startDetection();
    first.unmount();

    mount();
    await startDetection();

    expect(mocks.findOrphanChats).toHaveBeenCalledTimes(1);
  });

  it('skips the chats already kept', async () => {
    mocks.configGet.mockReturnValue(['old1']);
    mount();
    await startDetection();

    expect(mocks.findOrphanChats).toHaveBeenCalledWith(['old1']);
  });

  /** Settings that only exist once the config cache has loaded. */
  const settingsLoadLater = (stored: string[]) => {
    let loaded = false;
    let release: () => void = () => {};
    mocks.whenReady.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            loaded = true;
            resolve();
          };
        })
    );
    mocks.configGet.mockImplementation(() => (loaded ? stored : undefined));
    return () => release();
  };

  it('waits for the settings to load before reading the kept chats', async () => {
    const release = settingsLoadLater(['old1']);
    mount();
    await startDetection();
    expect(mocks.findOrphanChats).not.toHaveBeenCalled();

    await act(async () => {
      release();
    });

    expect(mocks.findOrphanChats).toHaveBeenCalledWith(['old1']);
  });

  it('Keep waits for the settings too, so it never overwrites the stored list', async () => {
    mocks.findOrphanChats.mockResolvedValue(chats(1));
    mount();
    await startDetection();
    const release = settingsLoadLater(['old1']);

    await act(async () => {
      fireEvent.click(keepButton());
    });
    expect(mocks.configSet).not.toHaveBeenCalled();
    await act(async () => {
      release();
    });

    expect(mocks.configSet).toHaveBeenCalledWith('agent.keptOrphanChats', ['old1', 'c1']);
  });

  it('Keep remembers the ids next to the ones already kept, deletes nothing and closes', async () => {
    mocks.configGet.mockReturnValue(['old1']);
    mocks.findOrphanChats.mockResolvedValue(chats(2));
    mount();
    await startDetection();

    await act(async () => {
      fireEvent.click(keepButton());
    });

    expect(mocks.configSet).toHaveBeenCalledWith('agent.keptOrphanChats', ['old1', 'c1', 'c2']);
    expect(mocks.removeChats).not.toHaveBeenCalled();
    await closeAnimation();
    expect(screen.queryByRole('button', { name: 'agent.orphanChats.keep' })).not.toBeInTheDocument();
  });

  it('deletes nothing until the Delete click', async () => {
    mocks.findOrphanChats.mockResolvedValue(chats(2));
    mount();
    await startDetection();

    expect(mocks.removeChats).not.toHaveBeenCalled();
  });

  it('Delete reuses removeChats with the orphans, refreshes history and closes', async () => {
    const orphans = chats(3);
    mocks.findOrphanChats.mockResolvedValue(orphans);
    mount();
    await startDetection();

    await act(async () => {
      fireEvent.click(deleteButton());
    });

    expect(mocks.removeChats).toHaveBeenCalledWith(
      orphans,
      expect.objectContaining({ onProgress: expect.any(Function) })
    );
    expect(mocks.emit).toHaveBeenCalledWith('chat.history.refresh');
    expect(mocks.configSet).not.toHaveBeenCalled();
    await closeAnimation();
    expect(screen.queryByRole('button', { name: 'agent.orphanChats.keep' })).not.toBeInTheDocument();
  });

  it('shows the progress and disables both buttons while deleting', async () => {
    mocks.findOrphanChats.mockResolvedValue(chats(4));
    let finish: (value: { removed: string[]; failed: string[] }) => void = () => {};
    mocks.removeChats.mockImplementation(
      (_list: TChatConversation[], options: { onProgress?: (done: number, total: number) => void }) => {
        options.onProgress?.(1, 4);
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
    );
    mount();
    await startDetection();

    await act(async () => {
      fireEvent.click(deleteButton());
    });

    expect(screen.getByText('agent.deleteBot.progress|done=1,total=4')).toBeInTheDocument();
    expect(keepButton()).toBeDisabled();

    await act(async () => {
      finish({ removed: ['c1', 'c2', 'c3', 'c4'], failed: [] });
    });
  });

  it('goes home when the open chat is one of the deleted', async () => {
    mocks.openChatId.value = 'c2';
    mocks.findOrphanChats.mockResolvedValue(chats(3));
    mocks.removeChats.mockImplementation(
      async (list: TChatConversation[], options: { onRemoved?: (id: string) => void }) => {
        list.forEach((c) => options.onRemoved?.(c.id));
        return { removed: list.map((c) => c.id), failed: [] };
      }
    );
    mount();
    await startDetection();

    await act(async () => {
      fireEvent.click(deleteButton());
    });

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith('/');
  });

  it('reports a partial failure and keeps offering only the chats that are left', async () => {
    const errorSpy = vi.spyOn(Message, 'error').mockImplementation(() => ({ close: vi.fn() }) as never);
    mocks.findOrphanChats.mockResolvedValue(chats(3));
    mocks.removeChats.mockResolvedValue({ removed: ['c1', 'c3'], failed: ['c2'] });
    mount();
    await startDetection();

    await act(async () => {
      fireEvent.click(deleteButton());
    });

    expect(errorSpy).toHaveBeenCalledWith('agent.orphanChats.deleteFailed|failed=1,count=3');
    expect(mocks.emit).toHaveBeenCalledWith('chat.history.refresh');
    expect(screen.getByText('agent.orphanChats.title|count=1')).toBeInTheDocument();
    expect(screen.getByText('Chat c2')).toBeInTheDocument();
    expect(screen.queryByText('Chat c1')).not.toBeInTheDocument();
  });
});
