/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The app's reminder list: one JSON file under userData, read once and written in order. The user manages it from
 * the titlebar bell; every agent reaches it through `POST /api/reminders/{add,list,done,snooze,reschedule}` on the
 * token-guarded artifact server (the notes MCP's reminder tools), so a bot can set a reminder when the user asks.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';

import { REMINDER_LIMITS, isReminderDue, type Reminder } from '@/common/types/agent/reminders';

const MINUTE_MS = 60_000;
const YEAR_MS = 365 * 24 * 60 * MINUTE_MS;
/** Done reminders are dropped after this long, so the file does not grow forever. */
const DONE_KEPT_MS = 30 * 24 * 60 * MINUTE_MS;
/** Writes (add, done, snooze, reschedule) one chat may make per app run. */
export const REMINDER_WRITES_PER_CHAT = 30;

export type ReminderInput = { title: string; dueAt: number; note?: string; createdBy: Reminder['createdBy'] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const parseStored = (value: unknown): Reminder | null => {
  if (!isRecord(value)) return null;
  const { id, title, note, dueAt, createdAt, doneAt, createdBy } = value;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof dueAt !== 'number') return null;
  return {
    id,
    title,
    ...(typeof note === 'string' && note ? { note } : {}),
    dueAt,
    createdAt: typeof createdAt === 'number' ? createdAt : dueAt,
    doneAt: typeof doneAt === 'number' ? doneAt : null,
    createdBy: createdBy === 'agent' ? 'agent' : 'user',
  };
};

const readStored = (file: string): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[reminders] the reminder list is unreadable; starting it over:', error);
    }
    return [];
  }
};

/** Open reminders first, soonest first; done ones after, most recently done first. */
const ordered = (items: Reminder[]): Reminder[] =>
  items.toSorted((a, b) => {
    if ((a.doneAt === null) !== (b.doneAt === null)) return a.doneAt === null ? -1 : 1;
    return a.doneAt === null ? a.dueAt - b.dueAt : (b.doneAt ?? 0) - (a.doneAt ?? 0);
  });

export function createReminderStore(file: string, now: () => number = Date.now) {
  let items: Reminder[] = readStored(file)
    .map(parseStored)
    .filter((r): r is Reminder => r !== null && (r.doneAt === null || now() - r.doneAt < DONE_KEPT_MS));
  let writing: Promise<void> = Promise.resolve();
  const listeners = new Set<(list: Reminder[]) => void>();

  const commit = async (next: Reminder[]): Promise<void> => {
    items = next;
    const snapshot = JSON.stringify(items);
    // Written aside, then renamed over the list: a quit mid-write must not leave an empty file.
    writing = writing
      .catch((): void => undefined)
      .then(async () => {
        await fs.writeFile(`${file}.tmp`, snapshot);
        await fs.rename(`${file}.tmp`, file);
      });
    await writing;
    const list = ordered(items);
    for (const listener of listeners) listener(list);
  };

  const find = (id: string): Reminder => {
    const found = items.find((r) => r.id === id);
    if (!found) throw new Error('No such reminder');
    return found;
  };

  const checkDue = (dueAt: number): void => {
    if (!Number.isFinite(dueAt) || Math.abs(dueAt - now()) > 10 * YEAR_MS) throw new Error('The due time is not valid');
  };

  const replace = async (id: string, patch: Partial<Reminder>): Promise<Reminder> => {
    const updated = { ...find(id), ...patch };
    await commit(items.map((r) => (r.id === id ? updated : r)));
    return updated;
  };

  return {
    list: (): Reminder[] => ordered(items),
    async add(input: ReminderInput): Promise<Reminder> {
      const title = input.title.trim();
      const note = input.note?.trim();
      if (!title || title.length > REMINDER_LIMITS.maxTitleChars) {
        throw new Error(`The title needs 1 to ${REMINDER_LIMITS.maxTitleChars} characters`);
      }
      if (note && note.length > REMINDER_LIMITS.maxNoteChars) {
        throw new Error(`The note can have at most ${REMINDER_LIMITS.maxNoteChars} characters`);
      }
      checkDue(input.dueAt);
      if (items.filter((r) => r.doneAt === null).length >= REMINDER_LIMITS.maxOpen) {
        throw new Error(`At most ${REMINDER_LIMITS.maxOpen} open reminders`);
      }
      const reminder: Reminder = {
        id: randomUUID(),
        title,
        ...(note ? { note } : {}),
        dueAt: input.dueAt,
        createdAt: now(),
        doneAt: null,
        createdBy: input.createdBy,
      };
      await commit([...items, reminder]);
      return reminder;
    },
    /** Due again `minutes` from now. */
    async snooze(id: string, minutes: number): Promise<Reminder> {
      find(id);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > REMINDER_LIMITS.maxSnoozeMinutes) {
        throw new Error(`Snooze for 1 to ${REMINDER_LIMITS.maxSnoozeMinutes} minutes`);
      }
      return replace(id, { dueAt: now() + minutes * MINUTE_MS, doneAt: null });
    },
    /** Moves the due time; a done reminder opens again. */
    async reschedule(id: string, dueAt: number): Promise<Reminder> {
      checkDue(dueAt);
      return replace(id, { dueAt, doneAt: null });
    },
    done: (id: string): Promise<Reminder> => replace(id, { doneAt: now() }),
    async remove(id: string): Promise<void> {
      find(id);
      await commit(items.filter((r) => r.id !== id));
    },
    onChange(listener: (list: Reminder[]) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ReminderStore = ReturnType<typeof createReminderStore>;

export type RemindersApiBody = Record<string, unknown> & { conversationId: string };
type Reply = { ok: true; value: Record<string, unknown> } | { ok: false; error: string; message: string };
export type RemindersApiHandler = (op: string, body: RemindersApiBody) => Promise<Reply>;

const badRequest = (message: string): Reply => ({ ok: false, error: 'bad-content', message });

/** The due time an agent sent: an ISO date and time (`due`) or minutes from now (`inMinutes`). */
const dueFrom = (body: RemindersApiBody, now: number): number | string => {
  if (typeof body.inMinutes === 'number') {
    if (!Number.isInteger(body.inMinutes) || body.inMinutes < 1) return 'inMinutes must be a whole number above 0';
    return now + body.inMinutes * MINUTE_MS;
  }
  if (typeof body.due !== 'string') return 'Give due (an ISO 8601 date and time) or inMinutes';
  const parsed = Date.parse(body.due);
  return Number.isNaN(parsed) ? `due is not a date and time: ${body.due.slice(0, 40)}` : parsed;
};

const idOf = (body: RemindersApiBody): string | null => (typeof body.id === 'string' && body.id ? body.id : null);

/** The agents' side of the reminder list. Answers every request; a store failure is a message, never a throw. */
export function createRemindersApi(
  store: ReminderStore,
  { now = Date.now, writesPerChat = REMINDER_WRITES_PER_CHAT }: { now?: () => number; writesPerChat?: number } = {}
): RemindersApiHandler {
  const writes = new Map<string, number>();
  const shown = (r: Reminder) => ({
    id: r.id,
    title: r.title,
    ...(r.note ? { note: r.note } : {}),
    dueAt: r.dueAt,
    dueLocal: new Date(r.dueAt).toString(),
    due: isReminderDue(r, now()),
    done: r.doneAt !== null,
  });

  const write = async (op: string, body: RemindersApiBody): Promise<Reminder | string> => {
    if (op === 'add') {
      if (typeof body.title !== 'string') return 'A reminder needs a title';
      const dueAt = dueFrom(body, now());
      if (typeof dueAt === 'string') return dueAt;
      const note = typeof body.note === 'string' ? body.note : undefined;
      return store.add({ title: body.title, dueAt, note, createdBy: 'agent' });
    }
    const id = idOf(body);
    if (!id) return 'Give the id of a reminder from reminder_list';
    if (op === 'done') return store.done(id);
    if (op === 'snooze') return store.snooze(id, Number(body.minutes));
    if (op !== 'reschedule') return `Unknown reminder operation: ${op}`;
    const dueAt = dueFrom(body, now());
    return typeof dueAt === 'string' ? dueAt : store.reschedule(id, dueAt);
  };

  return async (op, body) => {
    try {
      if (op === 'list') {
        const reminders = store.list().filter((r) => body.includeDone === true || r.doneAt === null);
        return { ok: true, value: { now: new Date(now()).toString(), reminders: reminders.map(shown) } };
      }
      const used = writes.get(body.conversationId) ?? 0;
      if (used >= writesPerChat) {
        return { ok: false, error: 'rate-limited', message: `This chat already changed ${writesPerChat} reminders` };
      }
      const result = await write(op, body);
      if (typeof result === 'string') return badRequest(result);
      writes.set(body.conversationId, used + 1);
      return { ok: true, value: { reminder: shown(result) } };
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : String(error));
    }
  };
}
