/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTunnelManager,
  WEBUI_OFF_MESSAGE,
  type ChildLike,
  type TunnelStatus,
} from '@process/webuiTunnel/tunnelManager';

class FakeChild extends EventEmitter implements ChildLike {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  exitOn: string | null = 'SIGTERM';
  constructor(readonly pid: number) {
    super();
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    if (signal === this.exitOn || signal === 'SIGKILL') queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
  print(text: string, stream: 'stdout' | 'stderr' = 'stderr') {
    this[stream].emit('data', Buffer.from(text));
  }
  crash(code = 1) {
    this.emit('exit', code, null);
  }
}

const URL_LINE = (name: string) =>
  `2026-10-20T10:00:00Z INF |  https://${name}.trycloudflare.com                                       |\n`;

const setup = (opts: { port?: number | null; platform?: string } = {}) => {
  let port: number | null = opts.port === undefined ? 25809 : opts.port;
  const children: FakeChild[] = [];
  const statuses: TunnelStatus[] = [];
  const ensureBinary = vi.fn(async (_onDownload: () => void) => '/data/bin/cloudflared');
  const spawn = vi.fn((_cmd: string, _args: string[]) => {
    const child = new FakeChild(1000 + children.length);
    children.push(child);
    return child;
  });
  const taskkill = vi.fn((pid: number) => {
    const child = children.find((c) => c.pid === pid);
    queueMicrotask(() => child?.emit('exit', 1, null));
  });
  const manager = createTunnelManager({
    ensureBinary,
    spawn,
    getWebuiPort: () => port,
    emit: (s) => statuses.push(s),
    platform: opts.platform ?? 'darwin',
    taskkill,
  });
  const last = () => children[children.length - 1];
  return {
    manager,
    children,
    statuses,
    ensureBinary,
    spawn,
    taskkill,
    last,
    setPort: (p: number | null) => (port = p),
  };
};

/** Starts the manager and makes the newest child print a URL. */
const startRunning = async (t: ReturnType<typeof setup>, name = 'quiet-river-1234') => {
  const spawned = t.spawn.mock.calls.length;
  const started = t.manager.start();
  await vi.waitFor(() => expect(t.spawn).toHaveBeenCalledTimes(spawned + 1));
  t.last().print(URL_LINE(name));
  await started;
};

describe('createTunnelManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('moves starting, then running with the URL, ignoring noise before it', async () => {
    const t = setup();
    const started = t.manager.start();
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalled());
    expect(t.spawn).toHaveBeenCalledWith('/data/bin/cloudflared', [
      'tunnel',
      '--no-autoupdate',
      '--protocol',
      'http2',
      '--url',
      'http://127.0.0.1:25809',
    ]);
    t.last().print('INF Requesting new quick Tunnel on trycloudflare.com...\n');
    t.last().print('ERR failed to request: Post "https://api.trycloudflare.com/tunnel": EOF\n');
    t.last().print('INF |  https://quiet-river-');
    t.last().print('1234.trycloudflare.com   |\n');
    await started;
    expect(t.statuses.map((s) => s.state)).toEqual(['starting', 'running']);
    expect(t.manager.status()).toEqual({ state: 'running', url: 'https://quiet-river-1234.trycloudflare.com' });
  });

  it('shows downloading only while the binary is fetched', async () => {
    const t = setup();
    t.ensureBinary.mockImplementationOnce(async (onDownload) => {
      onDownload();
      return '/data/bin/cloudflared';
    });
    await startRunning(t);
    expect(t.statuses.map((s) => s.state)).toEqual(['starting', 'downloading', 'starting', 'running']);
  });

  it('shares one binary step between a stale and a new attempt', async () => {
    const t = setup();
    let release: (path: string) => void = () => {};
    t.ensureBinary.mockImplementationOnce(
      (onDownload) =>
        new Promise((resolve) => {
          onDownload();
          release = resolve;
        })
    );
    const first = t.manager.start();
    await t.manager.stop();
    const second = t.manager.start();
    await vi.waitFor(() => expect(t.manager.status()).toEqual({ state: 'downloading' }));
    release('/data/bin/cloudflared');
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalledTimes(1));
    t.last().print(URL_LINE('shared'));
    await Promise.all([first, second]);
    expect(t.ensureBinary).toHaveBeenCalledTimes(1);
    expect(t.manager.isActive()).toBe(true);
  });

  it('reads the URL from stdout too', async () => {
    const t = setup();
    const started = t.manager.start();
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalled());
    t.last().print(URL_LINE('from-stdout'), 'stdout');
    await started;
    expect(t.manager.status()).toEqual({ state: 'running', url: 'https://from-stdout.trycloudflare.com' });
  });

  it('gives an error and kills the process when no URL arrives within 60 s', async () => {
    const t = setup();
    const started = t.manager.start();
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(60_000);
    await started;
    expect(t.manager.status().state).toBe('error');
    expect(t.last().signals).toContain('SIGTERM');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it('gives an error when the download fails', async () => {
    const t = setup();
    t.ensureBinary.mockRejectedValueOnce(new Error('cloudflared checksum mismatch'));
    await t.manager.start();
    expect(t.manager.status()).toEqual({ state: 'error', message: 'cloudflared checksum mismatch' });
    // a user start that fails is not retried
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.ensureBinary).toHaveBeenCalledTimes(1);
    expect(t.spawn).not.toHaveBeenCalled();
  });

  it('a boot start that fails retries after 5 s', async () => {
    const t = setup();
    t.ensureBinary.mockRejectedValueOnce(new Error('offline'));
    await t.manager.start({ retryOnFailure: true });
    expect(t.manager.status()).toEqual({ state: 'error', message: 'offline' });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(t.ensureBinary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it('gives an error when cloudflared exits before printing a URL', async () => {
    const t = setup();
    const started = t.manager.start();
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalled());
    t.last().crash(1);
    await started;
    expect(t.manager.status()).toMatchObject({ state: 'error' });
  });

  it('restarts after 5 s with a new URL when the process exits while running', async () => {
    const t = setup();
    await startRunning(t, 'first-url');
    t.last().crash();
    expect(t.manager.status().state).toBe('error');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(t.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalledTimes(2));
    t.last().print(URL_LINE('second-url'));
    await vi.waitFor(() =>
      expect(t.manager.status()).toEqual({ state: 'running', url: 'https://second-url.trycloudflare.com' })
    );
  });

  it('backs off 5 s, 15 s, 60 s, then stops retrying after 3 consecutive failures', async () => {
    const t = setup();
    await startRunning(t);
    t.last().crash();
    // vi.waitFor would move the fake clock, so this flushes with zero-length advances instead
    for (const delay of [5_000, 15_000, 60_000]) {
      const before = t.spawn.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(t.spawn).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(t.spawn).toHaveBeenCalledTimes(before + 1);
      t.last().crash();
      expect(t.manager.status().state).toBe('error');
    }
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.spawn).toHaveBeenCalledTimes(4);
    expect(t.manager.status().state).toBe('error');
  });

  it('a successful restart resets the backoff', async () => {
    const t = setup();
    await startRunning(t);
    t.last().crash();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalledTimes(2));
    t.last().print(URL_LINE('back-again'));
    await vi.waitFor(() => expect(t.manager.isActive()).toBe(true));
    t.last().crash();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalledTimes(3));
  });

  it('stop() kills the process, gives stopped and cancels a pending restart', async () => {
    const t = setup();
    await startRunning(t);
    const child = t.last();
    await t.manager.stop();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(t.manager.status()).toEqual({ state: 'stopped' });
    expect(t.statuses[t.statuses.length - 1]).toEqual({ state: 'stopped' });

    await startRunning(t);
    t.last().crash();
    await t.manager.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.spawn).toHaveBeenCalledTimes(2);
    expect(t.manager.status()).toEqual({ state: 'stopped' });
  });

  it('stop() sends SIGKILL when the process ignores SIGTERM for 3 s', async () => {
    const t = setup();
    await startRunning(t);
    const child = t.last();
    child.exitOn = null;
    const stopped = t.manager.stop();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stop() kills the whole tree with taskkill on Windows', async () => {
    const t = setup({ platform: 'win32' });
    await startRunning(t);
    const child = t.last();
    await t.manager.stop();
    expect(t.taskkill).toHaveBeenCalledWith(child.pid);
    expect(child.signals).toEqual([]);
  });

  it('stop() during the download keeps it stopped', async () => {
    const t = setup();
    let release: (path: string) => void = () => {};
    t.ensureBinary.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const started = t.manager.start();
    await t.manager.stop();
    release('/data/bin/cloudflared');
    await started;
    expect(t.spawn).not.toHaveBeenCalled();
    expect(t.manager.status()).toEqual({ state: 'stopped' });
  });

  it('start() while the WebUI is off rejects with "Turn on WebUI first"', async () => {
    const t = setup({ port: null });
    await expect(t.manager.start()).rejects.toThrow(WEBUI_OFF_MESSAGE);
    expect(WEBUI_OFF_MESSAGE).toBe('Turn on WebUI first');
    expect(t.ensureBinary).not.toHaveBeenCalled();
    expect(t.manager.status()).toEqual({ state: 'stopped' });
  });

  it('start() while already running does nothing', async () => {
    const t = setup();
    await startRunning(t);
    await t.manager.start();
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it('onWebuiRestarted() with a new port restarts the tunnel against it', async () => {
    const t = setup();
    await startRunning(t);
    const old = t.last();
    t.setPort(25810);
    t.manager.onWebuiRestarted();
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalledTimes(2));
    expect(old.signals).toEqual(['SIGTERM']);
    expect(t.spawn.mock.calls[1][1]).toContain('http://127.0.0.1:25810');
    t.last().print(URL_LINE('new-port'));
    await vi.waitFor(() => expect(t.manager.isActive()).toBe(true));
    // the old process exiting is not a crash
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.spawn).toHaveBeenCalledTimes(2);
  });

  it('onWebuiRestarted() while the binary is being prepared does nothing (the port is read at spawn)', async () => {
    const t = setup();
    let release: (path: string) => void = () => {};
    t.ensureBinary.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const started = t.manager.start();
    await vi.waitFor(() => expect(t.ensureBinary).toHaveBeenCalled());
    t.setPort(25810);
    t.manager.onWebuiRestarted();
    release('/data/bin/cloudflared');
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalledTimes(1));
    expect(t.spawn.mock.calls[0][1]).toContain('http://127.0.0.1:25810');
    t.last().print(URL_LINE('port'));
    await started;
    expect(t.ensureBinary).toHaveBeenCalledTimes(1);
  });

  it('onWebuiRestarted() on the same port, or with the tunnel off, does nothing', async () => {
    const t = setup();
    t.manager.onWebuiRestarted();
    await startRunning(t);
    t.manager.onWebuiRestarted();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.spawn).toHaveBeenCalledTimes(1);
  });

  it('isActive() is true only while running', async () => {
    const t = setup();
    expect(t.manager.isActive()).toBe(false);
    const started = t.manager.start();
    await vi.waitFor(() => expect(t.spawn).toHaveBeenCalled());
    expect(t.manager.isActive()).toBe(false);
    t.last().print(URL_LINE('active'));
    await started;
    expect(t.manager.isActive()).toBe(true);
    t.last().crash();
    expect(t.manager.isActive()).toBe(false);
    await t.manager.stop();
    expect(t.manager.isActive()).toBe(false);
  });
});
