/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '@/common/types/agent/reminders';

const h = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(() => Promise.resolve({ success: true })),
  snooze: vi.fn(() => Promise.resolve({ success: true })),
  reschedule: vi.fn(() => Promise.resolve({ success: true })),
  done: vi.fn(() => Promise.resolve({ success: true })),
  changed: null as ((items: Reminder[]) => void) | null,
  messageError: vi.fn(),
}));

// Arco's imperative Message needs a legacy ReactDOM.render, which React 19 lacks in jsdom.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, error: h.messageError } };
});
vi.mock('@/common', () => ({
  ipcBridge: {
    reminders: {
      list: { invoke: h.list },
      add: { invoke: h.add },
      snooze: { invoke: h.snooze },
      reschedule: { invoke: h.reschedule },
      done: { invoke: h.done },
      changed: {
        on: (handler: (items: Reminder[]) => void) => {
          h.changed = handler;
          return () => {};
        },
      },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import RemindersButton from '@/renderer/components/layout/Titlebar/RemindersButton';

const KEY = 'common.reminders';
const NOW = Date.parse('2026-10-24T09:00:00Z');
const reminder = (id: string, dueAt: number, patch: Partial<Reminder> = {}): Reminder => ({
  id,
  title: `Reminder ${id}`,
  dueAt,
  createdAt: NOW - 60_000,
  doneAt: null,
  createdBy: 'user',
  ...patch,
});

const renderBell = async (items: Reminder[]) => {
  h.list.mockResolvedValue({ success: true, data: items });
  const view = render(<RemindersButton buttonClassName='app-titlebar__button' iconSize={18} />);
  await act(async () => {});
  return view;
};
const openList = () => fireEvent.click(screen.getByRole('button', { name: `${KEY}.title` }));

beforeEach(() => {
  vi.clearAllMocks();
  // Only the clock: a fake setTimeout would also stall findBy* polling and the popover's timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the reminders bell', () => {
  it('shows a red dot only while a reminder is due, and lights up when the next one comes due', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: NOW });
    const view = await renderBell([reminder('later', NOW + 60_000)]);
    expect(view.container.querySelector('.arco-badge-dot')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });

    expect(view.container.querySelector('.arco-badge-dot')).not.toBeNull();
  });

  it('marks a reminder done and snoozes another from the list', async () => {
    await renderBell([reminder('a', NOW - 60_000), reminder('b', NOW - 30_000)]);
    openList();

    fireEvent.click((await screen.findAllByRole('button', { name: `${KEY}.done` }))[0]);
    expect(h.done).toHaveBeenCalledWith({ id: 'a' });

    fireEvent.click(screen.getAllByRole('button', { name: `${KEY}.snooze` })[1]);
    fireEvent.click(await screen.findByText(`${KEY}.snooze10m`));
    expect(h.snooze).toHaveBeenCalledWith({ id: 'b', minutes: 10 });
  });

  it('adds a reminder with its title, due in an hour unless a time is picked', async () => {
    await renderBell([]);
    openList();
    expect(await screen.findByText(`${KEY}.empty`)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(`${KEY}.newPlaceholder`), { target: { value: 'Call Sam' } });
    fireEvent.click(screen.getByRole('button', { name: `${KEY}.add` }));

    expect(h.add).toHaveBeenCalledWith({ title: 'Call Sam', dueAt: NOW + 60 * 60_000 });
  });

  it('follows changes from main, such as a reminder a bot set', async () => {
    const view = await renderBell([]);
    act(() => h.changed?.([reminder('bot', NOW - 1000, { createdBy: 'agent' })]));
    expect(view.container.querySelector('.arco-badge-dot')).not.toBeNull();
  });

  it('says so when a change could not be saved', async () => {
    h.done.mockResolvedValueOnce({ success: false, msg: 'disk full' } as never);
    await renderBell([reminder('a', NOW - 60_000)]);
    openList();

    fireEvent.click(await screen.findByRole('button', { name: `${KEY}.done` }));
    await act(async () => {});

    expect(h.messageError).toHaveBeenCalledWith(`${KEY}.failed`);
  });
});
