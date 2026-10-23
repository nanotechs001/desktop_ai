/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The reminder tools of the `aionui-notes` MCP (every engine loads it), end to end: the tool, the token-guarded
 * `/api/reminders/*` route and the store. A bot asked to "remind me in 30 minutes" creates a reminder the bell shows.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startArtifacts } from '@process/artifacts';
import { createReminderStore, createRemindersApi, type ReminderStore } from '@process/artifacts/reminders';
import { createArtifactsApi } from '@process/resources/builtinMcp/aionArtifacts/apiClient';
import { createNotesMcpServer } from '@process/resources/builtinMcp/aionNotes/tools';

vi.mock('@/common', () => ({ ipcBridge: {} }));

type ToolReply = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const textOf = (reply: ToolReply): string => reply.content.map((part) => part.text ?? '').join('');

let root: string;
let store: ReminderStore;
let started: NonNullable<Awaited<ReturnType<typeof startArtifacts>>> | undefined;
const closers: Array<() => Promise<void>> = [];

const connect = async (token?: string): Promise<Client> => {
  const env = {
    AION_ARTIFACTS_URL: started?.server.origin,
    AION_ARTIFACTS_TOKEN: token ?? started?.token,
    AIONUI_CONVERSATION_ID: 'chat-1',
  };
  const server = createNotesMcpServer(createArtifactsApi(env, fetch, 'Notes'));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  closers.push(() => client.close());
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolReply> =>
  (await client.callTool({ name, arguments: args })) as ToolReply;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'reminder-mcp-'));
  store = createReminderStore(path.join(root, 'reminders.json'));
  started = (await startArtifacts({ rootDir: root, reminders: createRemindersApi(store) })) ?? undefined;
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await started?.server.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('aionui-notes reminder tools', () => {
  it('sets a reminder in minutes from now, lists it, then marks it done', async () => {
    const client = await connect();

    const added = await call(client, 'reminder_add', { title: 'Call the client back', inMinutes: 30 });
    expect(added.isError, textOf(added)).toBeFalsy();
    const { reminder } = JSON.parse(textOf(added)) as { reminder: { id: string; due: boolean } };
    expect(reminder.due).toBe(false);
    expect(store.list()).toEqual([expect.objectContaining({ title: 'Call the client back', createdBy: 'agent' })]);

    const listed = JSON.parse(textOf(await call(client, 'reminder_list', {}))) as { reminders: { id: string }[] };
    expect(listed.reminders.map((r) => r.id)).toEqual([reminder.id]);

    await call(client, 'reminder_done', { id: reminder.id });
    expect(store.list()[0].doneAt).not.toBeNull();
  });

  it('moves and snoozes a reminder', async () => {
    const client = await connect();
    const created = await store.add({ title: 'Pay invoice', dueAt: Date.now() - 1000, createdBy: 'user' });

    await call(client, 'reminder_reschedule', { id: created.id, due: '2030-01-02T09:00:00Z' });
    expect(store.list()[0].dueAt).toBe(Date.parse('2030-01-02T09:00:00Z'));
    await call(client, 'reminder_snooze', { id: created.id, minutes: 10 });
    expect(store.list()[0].dueAt).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it('refuses a caller without the session token', async () => {
    const reply = await call(await connect('wrong-token'), 'reminder_list', {});
    expect(reply.isError).toBe(true);
  });
});
