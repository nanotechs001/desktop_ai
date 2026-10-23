/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Provider = (request: unknown) => Promise<unknown>;

const h = vi.hoisted(() => {
  const providers = new Map<string, Provider>();
  const provider = (name: string) => ({ provider: (fn: Provider) => providers.set(name, fn) });
  return {
    providers,
    userData: '',
    changed: vi.fn(),
    contentsListeners: [] as ((contents: unknown) => void)[],
    bridge: {
      browser: {
        bookmarks: {
          list: provider('list'),
          add: provider('add'),
          remove: provider('remove'),
          changed: { emit: (list: unknown) => h.changed(list) },
        },
        suggestUrls: provider('suggest'),
      },
    },
  };
});
vi.mock('@/common', () => ({ ipcBridge: h.bridge }));
vi.mock('electron', () => ({ app: { getPath: () => h.userData, on: vi.fn() } }));
vi.mock('@process/services/browserSession/browserSession', () => ({
  onBrowserContentsCreated: (listener: (contents: unknown) => void) => h.contentsListeners.push(listener),
}));

import { listBookmarks, registerBrowsingDataIpc } from '@process/services/browserSession/profiles/browsingDataIpc';

/** A browser tab's webContents: a webview on a persistent (saved) or in-memory session. */
const tab = (persistent: boolean) =>
  Object.assign(new EventEmitter(), {
    getType: () => 'webview',
    getTitle: () => 'Docs',
    getURL: () => 'https://docs.example.com/',
    session: { isPersistent: () => persistent },
  });

beforeAll(() => {
  h.userData = mkdtempSync(path.join(os.tmpdir(), 'browsing-ipc-'));
  registerBrowsingDataIpc();
});

describe('the browsing data IPC', () => {
  it('adds and removes bookmarks, tells the panes, and lets agents read them', async () => {
    expect(await h.providers.get('add')?.({ url: 'https://a.test/', title: 'A' })).toEqual({ success: true });
    expect(h.changed).toHaveBeenLastCalledWith([expect.objectContaining({ url: 'https://a.test/', title: 'A' })]);
    expect(listBookmarks().map((b) => b.url)).toEqual(['https://a.test/']);

    expect(await h.providers.get('add')?.({ url: 'javascript:alert(1)', title: 'x' })).toMatchObject({
      success: false,
    });
    expect(await h.providers.get('remove')?.({ url: 'https://a.test/' })).toEqual({ success: true });
    expect(await h.providers.get('list')?.(undefined)).toEqual([]);
  });

  it('suggests pages visited in saved browser sessions, never in a chat’s temporary browser', async () => {
    const saved = tab(true);
    const temporary = tab(false);
    for (const listener of h.contentsListeners) {
      listener(saved);
      listener(temporary);
    }
    temporary.emit('did-navigate', {}, 'https://secret.example.com/');
    saved.emit('did-navigate', {}, 'https://docs.example.com/');

    const suggestions = (await h.providers.get('suggest')?.({ query: 'example' })) as { url: string }[];
    expect(suggestions.map((s) => s.url)).toEqual(['https://docs.example.com/']);
  });
});
