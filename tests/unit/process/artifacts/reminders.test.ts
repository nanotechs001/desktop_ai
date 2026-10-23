/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createReminderStore, createRemindersApi } from '@process/artifacts/reminders';

const MIN = 60_000;
const NOW = Date.parse('2026-10-24T09:00:00Z');
const tempFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'reminders-')), 'reminders.json');

describe('the reminder store', () => {
  it('adds reminders, lists open ones by due time, and keeps them on disk', async () => {
    const file = tempFile();
    const store = createReminderStore(file, () => NOW);

    await store.add({ title: 'Later', dueAt: NOW + 60 * MIN, createdBy: 'user' });
    await store.add({ title: 'Sooner', dueAt: NOW + 5 * MIN, note: 'call back', createdBy: 'agent' });

    expect(store.list().map((r) => r.title)).toEqual(['Sooner', 'Later']);
    expect(
      createReminderStore(file, () => NOW)
        .list()
        .map((r) => r.title)
    ).toEqual(['Sooner', 'Later']);
  });

  it('snoozes from now, moves the date (reopening it), and marks it done', async () => {
    let now = NOW;
    const store = createReminderStore(tempFile(), () => now);
    const reminder = await store.add({ title: 'Pay invoice', dueAt: NOW - MIN, createdBy: 'user' });

    now = NOW + 2 * MIN;
    expect((await store.snooze(reminder.id, 10)).dueAt).toBe(now + 10 * MIN);
    expect((await store.done(reminder.id)).doneAt).toBe(now);
    const moved = await store.reschedule(reminder.id, NOW + 24 * 60 * MIN);
    expect(moved).toMatchObject({ dueAt: NOW + 24 * 60 * MIN, doneAt: null });
  });

  it('refuses bad input and unknown reminders', async () => {
    const store = createReminderStore(tempFile(), () => NOW);
    await expect(store.add({ title: '  ', dueAt: NOW, createdBy: 'user' })).rejects.toThrow();
    await expect(store.add({ title: 'x', dueAt: Number.NaN, createdBy: 'user' })).rejects.toThrow();
    await expect(store.snooze('nope', 10)).rejects.toThrow();
    const reminder = await store.add({ title: 'x', dueAt: NOW, createdBy: 'user' });
    await expect(store.snooze(reminder.id, 0)).rejects.toThrow();
    await store.remove(reminder.id);
    expect(store.list()).toEqual([]);
  });

  it('tells listeners about every change', async () => {
    const store = createReminderStore(tempFile(), () => NOW);
    const listener = vi.fn();
    store.onChange(listener);
    await store.add({ title: 'x', dueAt: NOW, createdBy: 'user' });
    expect(listener).toHaveBeenCalledWith([expect.objectContaining({ title: 'x' })]);
  });
});

const body = (extra: Record<string, unknown>) => ({ conversationId: 'chat-1', ...extra });

describe('the agents’ reminders API', () => {
  const api = () => {
    const store = createReminderStore(tempFile(), () => NOW);
    return { store, handle: createRemindersApi(store, { now: () => NOW, writesPerChat: 3 }) };
  };

  it('creates a reminder from a date and time, or from minutes from now, marked as made by an agent', async () => {
    const { store, handle } = api();

    const dated = (await handle('add', body({ title: 'Send report', due: '2026-10-24T17:30:00Z' }))) as {
      ok: boolean;
      value: { reminder: { id: string; dueAt: number } };
    };
    expect(dated.ok).toBe(true);
    expect(dated.value.reminder.dueAt).toBe(Date.parse('2026-10-24T17:30:00Z'));
    await handle('add', body({ title: 'Stretch', inMinutes: 30 }));

    expect(store.list().map((r) => [r.title, r.dueAt, r.createdBy])).toEqual([
      ['Stretch', NOW + 30 * MIN, 'agent'],
      ['Send report', Date.parse('2026-10-24T17:30:00Z'), 'agent'],
    ]);
  });

  it('lists open reminders with the current time, and marks one done, snoozed or moved', async () => {
    const { store, handle } = api();
    const added = await store.add({ title: 'Call Sam', dueAt: NOW - MIN, createdBy: 'user' });

    const listed = (await handle('list', body({}))) as { value: { now: string; reminders: { due: boolean }[] } };
    expect(listed.value.reminders).toEqual([expect.objectContaining({ id: added.id, title: 'Call Sam', due: true })]);
    expect(typeof listed.value.now).toBe('string');

    await handle('snooze', body({ id: added.id, minutes: 15 }));
    expect(store.list()[0].dueAt).toBe(NOW + 15 * MIN);
    await handle('reschedule', body({ id: added.id, due: '2026-10-25T09:00:00Z' }));
    expect(store.list()[0].dueAt).toBe(Date.parse('2026-10-25T09:00:00Z'));
    await handle('done', body({ id: added.id }));
    expect(store.list()[0].doneAt).toBe(NOW);
  });

  it('answers bad requests with a message, never throwing, and limits writes per chat', async () => {
    const { handle } = api();
    expect(await handle('add', body({ title: 'No time' }))).toMatchObject({ ok: false, error: 'bad-content' });
    expect(await handle('add', body({ title: 'x', due: 'whenever' }))).toMatchObject({ ok: false });
    expect(await handle('done', body({ id: 'missing' }))).toMatchObject({ ok: false });

    for (let i = 0; i < 3; i += 1) await handle('add', body({ title: `r${i}`, inMinutes: 5 }));
    expect(await handle('add', body({ title: 'one too many', inMinutes: 5 }))).toMatchObject({
      ok: false,
      error: 'rate-limited',
    });
  });
});
