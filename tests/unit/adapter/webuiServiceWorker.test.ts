/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * The WebUI service worker used to reload every open tab on its first
 * activation. A Cloudflare tunnel is a new origin each start, so a phone got a
 * surprise reload mid sign-in that replayed the spent `/qr-login?token=` URL.
 * Only a tab still running under an older worker (an older cache) needs it.
 */

const SW_SOURCE = readFileSync('public/sw.js', 'utf8');

type Listener = (event: { waitUntil: (work: Promise<unknown>) => void }) => void;

async function activateWith(existingCaches: string[]) {
  const listeners = new Map<string, Listener>();
  const navigate = vi.fn(async () => undefined);
  const deleted: string[] = [];
  const self = {
    location: { href: 'https://tunnel.example/sw.js', origin: 'https://tunnel.example' },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => undefined),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => [{ url: 'https://tunnel.example/qr-login?token=spent', navigate }]),
    },
  };
  const caches = {
    keys: async () => existingCaches,
    delete: async (key: string) => {
      deleted.push(key);
      return true;
    },
  };
  runInNewContext(SW_SOURCE, { self, caches, URL });

  let work: Promise<unknown> = Promise.resolve();
  listeners.get('activate')?.({ waitUntil: (promise) => (work = promise) });
  await work;
  return { navigate, deleted, claim: self.clients.claim };
}

describe('WebUI service worker activation', () => {
  it('claims but does not reload pages on a fresh install', async () => {
    const { navigate, claim } = await activateWith(['aionui-webui-v2']);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not reload pages when there were no caches at all', async () => {
    const { navigate } = await activateWith([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('drops the old cache and reloads pages still served by the old worker', async () => {
    const { navigate, deleted } = await activateWith(['aionui-webui-v1', 'aionui-webui-v2']);
    expect(deleted).toEqual(['aionui-webui-v1']);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
