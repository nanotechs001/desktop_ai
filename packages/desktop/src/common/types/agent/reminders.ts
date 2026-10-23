/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A reminder in the app's reminder list: the user's own, or one an agent created when the user asked. */
export type Reminder = {
  id: string;
  title: string;
  note?: string;
  /** When it is due, in ms since the epoch. */
  dueAt: number;
  createdAt: number;
  /** When it was marked done; null while it is open. */
  doneAt: number | null;
  createdBy: 'user' | 'agent';
};

export const REMINDER_LIMITS = {
  maxTitleChars: 200,
  maxNoteChars: 1000,
  /** Open reminders kept at once. */
  maxOpen: 500,
  /** Snooze at most this long (one week). */
  maxSnoozeMinutes: 7 * 24 * 60,
} as const;

/** An open reminder whose time has come: it lights the bell. */
export const isReminderDue = (reminder: Reminder, now: number): boolean =>
  reminder.doneAt === null && reminder.dueAt <= now;
