import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const NESTED_IFRAME =
  '<iframe name="nested" src="{{OTHER}}/builder-crossorigin.html?inner" style="left: 30px; top: 250px; width: 500px; height: 300px"></iframe>';

export type FixtureServers = {
  /** http://127.0.0.1:A */
  originA: string;
  /** http://localhost:B — a different site from A, so its frames become OOPIFs. */
  originB: string;
  close(): Promise<void>;
};

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

/**
 * Serves tests/integration/agentBrowser/fixtures on two loopback origins. In HTML, `{{OTHER}}` becomes the other
 * origin and `{{NESTED}}` a cross-origin iframe of builder-crossorigin.html (empty when the request has `?inner`).
 */
export async function startFixtureServers(): Promise<FixtureServers> {
  const origins = { a: '', b: '' };
  const serve = (other: () => string): Server =>
    createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fixture');
      const file = path.join(FIXTURES, path.basename(url.pathname));
      try {
        const html = (await readFile(file, 'utf8'))
          .replaceAll('{{NESTED}}', url.searchParams.has('inner') ? '' : NESTED_IFRAME)
          .replaceAll('{{OTHER}}', other());
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      } catch {
        res.writeHead(404).end();
      }
    });
  const serverA = serve(() => origins.b);
  const serverB = serve(() => origins.a);
  origins.a = `http://127.0.0.1:${await listen(serverA)}`;
  origins.b = `http://localhost:${await listen(serverB)}`;
  return {
    originA: origins.a,
    originB: origins.b,
    close: async () => {
      await Promise.all([serverA, serverB].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
    },
  };
}
