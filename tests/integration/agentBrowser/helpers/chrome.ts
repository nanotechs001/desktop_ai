import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { CdpConnection, createPipeTransport } from '@process/services/agentBrowser/cdpConnection';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const AUTO_ATTACH = { autoAttach: true, flatten: true, waitForDebuggerOnStart: false };
const LOAD_TIMEOUT_MS = 10_000;

/** Google Chrome on this machine, or null (tests skip). */
export const chromePath: string | null = existsSync(MAC_CHROME) ? MAC_CHROME : null;

export type TestChrome = {
  conn: CdpConnection;
  /** Opens a tab at `url`, waits for its load event and returns its flattened page session. */
  openPage(url: string): Promise<string>;
  close(): Promise<void>;
};

/**
 * Headless Chrome over --remote-debugging-pipe with a throwaway profile. It mirrors what the agent relay gives the
 * MCP: one flattened page session per tab, with OOPIFs auto-attached on every level (the relay re-issues
 * Target.setAutoAttach on each child session; raw Chrome needs us to do the same).
 */
export async function launchTestChrome(executable: string): Promise<TestChrome> {
  const profile = await mkdtemp(path.join(tmpdir(), 'aion-observe-chrome-'));
  const child: ChildProcess = spawn(
    executable,
    [
      '--headless=new',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1200,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] }
  );
  const conn = new CdpConnection(createPipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable));
  conn.on('Target.attachedToTarget', (params) => {
    if (typeof params.sessionId !== 'string') return;
    // A frame can detach before this lands; that is not a test failure.
    conn.send('Target.setAutoAttach', AUTO_ATTACH, params.sessionId).catch(() => {});
  });

  const openPage = async (url: string): Promise<string> => {
    const { targetId } = await conn.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await conn.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await conn.send('Page.enable', {}, sessionId);
    await conn.send('Target.setAutoAttach', AUTO_ATTACH, sessionId);
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`load timeout: ${url}`)), LOAD_TIMEOUT_MS);
      const off = conn.on('Page.loadEventFired', (_params, from) => {
        if (from !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve();
      });
    });
    await conn.send('Page.navigate', { url }, sessionId);
    await loaded;
    return sessionId;
  };

  const close = async (): Promise<void> => {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    conn.close();
    if (child.exitCode === null) await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true });
  };

  return { conn, openPage, close };
}
