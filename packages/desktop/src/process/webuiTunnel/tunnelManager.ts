/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runs a Cloudflare quick tunnel (the WebUI "secure link") against the local WebUI port.
 */

import { execFile } from 'node:child_process';
import type { TunnelStatus } from '@/common/adapter/ipcBridge';

export type { TunnelStatus };

export const WEBUI_OFF_MESSAGE = 'Turn on WebUI first';

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
const START_TIMEOUT_MS = 60_000;
const RESTART_BACKOFF_MS = [5_000, 15_000, 60_000];
const KILL_GRACE_MS = 3_000;
const MAX_PENDING_CHARS = 64 * 1024;

type DataSource = { on: (event: 'data', listener: (chunk: Buffer | string) => void) => unknown };

export type ChildLike = {
  pid?: number;
  stdout: DataSource | null;
  stderr: DataSource | null;
  on: ((event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown) &
    ((event: 'error', listener: (error: Error) => void) => unknown);
  kill: (signal?: NodeJS.Signals) => boolean;
};

type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void };

export type TunnelManagerDeps = {
  ensureBinary: () => Promise<string>;
  spawn: (cmd: string, args: string[]) => ChildLike;
  getWebuiPort: () => number | null;
  emit: (status: TunnelStatus) => void;
  timers?: Timers;
  platform?: string;
  taskkill?: (pid: number) => void;
};

export type TunnelManager = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  status: () => TunnelStatus;
  isActive: () => boolean;
  onWebuiRestarted: () => void;
};

type Proc = { child: ChildLike; port: number; done: boolean; exited: Promise<void>; settle: () => void };

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultTaskkill = (pid: number): void => {
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (error) => {
    if (error) console.warn('[WebUI tunnel] taskkill failed:', error.message);
  });
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** First quick-tunnel URL in a line; `api.trycloudflare.com` appears in cloudflared's own error lines. */
const findUrl = (line: string): string | null =>
  [...line.matchAll(URL_RE)].map((m) => m[0]).find((url) => url !== 'https://api.trycloudflare.com') ?? null;

const onLines = (source: DataSource | null, onLine: (line: string) => void): void => {
  let pending = '';
  source?.on('data', (chunk) => {
    const lines = (pending + chunk.toString()).split(/\r?\n/);
    pending = lines.pop() ?? '';
    if (pending.length > MAX_PENDING_CHARS) pending = '';
    lines.forEach(onLine);
  });
};

export function createTunnelManager(deps: TunnelManagerDeps): TunnelManager {
  const timers = deps.timers ?? defaultTimers;
  const isWindows = (deps.platform ?? process.platform) === 'win32';
  const taskkill = deps.taskkill ?? defaultTaskkill;

  let status: TunnelStatus = { state: 'stopped' };
  let wanted = false;
  /** Bumped on every new attempt, stop or restart; callbacks of an older attempt see a mismatch and back off. */
  let generation = 0;
  let current: Proc | null = null;
  let restarts = 0;
  let retryTimer: unknown = null;

  const setStatus = (next: TunnelStatus): void => {
    status = next;
    deps.emit(next);
  };

  const cancelRetry = (): void => {
    if (retryTimer === null) return;
    timers.clearTimeout(retryTimer);
    retryTimer = null;
  };

  /** Ends the process (whole tree on Windows); SIGKILL if it outlives the grace period. */
  const kill = async (proc: Proc): Promise<void> => {
    if (!proc.done) {
      let timer: unknown = null;
      const grace = new Promise<void>((resolve) => {
        timer = timers.setTimeout(() => {
          if (!proc.done && !isWindows) proc.child.kill('SIGKILL');
          resolve();
        }, KILL_GRACE_MS);
      });
      if (isWindows && proc.child.pid !== undefined) taskkill(proc.child.pid);
      else proc.child.kill('SIGTERM');
      await Promise.race([proc.exited, grace]);
      timers.clearTimeout(timer);
    }
    proc.settle();
  };

  const dropCurrent = async (): Promise<void> => {
    const proc = current;
    current = null;
    if (proc) await kill(proc);
  };

  const scheduleRestart = (): void => {
    if (restarts >= RESTART_BACKOFF_MS.length) return;
    const delay = RESTART_BACKOFF_MS[restarts];
    restarts += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (wanted) void attempt((generation += 1));
    }, delay);
  };

  /** A failed attempt; inside a restart chain it schedules the next try. */
  const fail = (message: string): void => {
    setStatus({ state: 'error', message });
    if (restarts > 0) scheduleRestart();
  };

  const spawnAndWait = (id: number, bin: string, port: number): Promise<void> =>
    new Promise<void>((settle) => {
      let markExited = (): void => {};
      const exited = new Promise<void>((resolve) => (markExited = resolve));
      let phase: 'starting' | 'running' | 'over' = 'starting';
      let child: ChildLike;
      try {
        child = deps.spawn(bin, [
          'tunnel',
          '--no-autoupdate',
          '--protocol',
          'http2',
          '--url',
          `http://127.0.0.1:${port}`,
        ]);
      } catch (error) {
        fail(messageOf(error));
        settle();
        return;
      }
      const proc: Proc = { child, port, done: false, exited, settle };
      current = proc;
      let startTimer: unknown = null;

      const conclude = (message: string): void => {
        const wasRunning = phase === 'running';
        phase = 'over';
        timers.clearTimeout(startTimer);
        if (current === proc) current = null;
        settle();
        if (id !== generation) return;
        if (!wasRunning) return fail(message);
        setStatus({ state: 'error', message });
        restarts = 0;
        scheduleRestart();
      };

      startTimer = timers.setTimeout(() => {
        if (phase !== 'starting') return;
        conclude('cloudflared did not start within 60 s');
        void kill(proc);
      }, START_TIMEOUT_MS);

      const onLine = (line: string): void => {
        const url = phase === 'starting' && id === generation ? findUrl(line) : null;
        if (!url) return;
        phase = 'running';
        timers.clearTimeout(startTimer);
        restarts = 0;
        setStatus({ state: 'running', url });
        settle();
      };
      onLines(child.stdout, onLine);
      onLines(child.stderr, onLine);

      child.on('error', (error) => {
        if (phase === 'over') return;
        conclude(messageOf(error));
        void kill(proc);
      });
      child.on('exit', (code, signal) => {
        proc.done = true;
        markExited();
        if (phase !== 'over') conclude(`cloudflared exited (${code ?? signal})`);
      });
    });

  const attempt = async (id: number): Promise<void> => {
    setStatus({ state: 'downloading' });
    let bin: string;
    try {
      bin = await deps.ensureBinary();
    } catch (error) {
      if (id === generation) fail(messageOf(error));
      return;
    }
    if (id !== generation) return;
    const port = deps.getWebuiPort();
    if (port === null) return fail(WEBUI_OFF_MESSAGE);
    setStatus({ state: 'starting' });
    await spawnAndWait(id, bin, port);
  };

  const restart = async (): Promise<void> => {
    const id = (generation += 1);
    restarts = 0;
    cancelRetry();
    await dropCurrent();
    if (id === generation && wanted) await attempt(id);
  };

  return {
    async start() {
      if (deps.getWebuiPort() === null) throw new Error(WEBUI_OFF_MESSAGE);
      if (wanted && status.state !== 'error') return;
      wanted = true;
      await restart();
    },
    async stop() {
      wanted = false;
      generation += 1;
      restarts = 0;
      cancelRetry();
      await dropCurrent();
      if (status.state !== 'stopped') setStatus({ state: 'stopped' });
    },
    status: () => status,
    isActive: () => status.state === 'running',
    onWebuiRestarted() {
      const port = deps.getWebuiPort();
      if (!wanted || port === null || status.state === 'downloading') return;
      if (current?.port === port && status.state !== 'error') return;
      void restart();
    },
  };
}
