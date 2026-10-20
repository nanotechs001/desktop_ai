/**
 * The artifact-view routes: `GET /api/artifact-view/a/<id>[/v/<n>]` (gated) and `GET /api/artifact-view/lib/<file>`
 * (open), forwarded to the desktop's loopback artifact server with its own Host and no client headers. Real TCP
 * listener, the fake aioncore and a fake artifact server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startStaticServer, type StaticServerHandle } from '../src/static-server.js';
import type { ArtifactViewRoutes } from '../src/types.js';
import { GOOD, request, startFakeBackend, STATIC_DIR, type FakeBackend } from './fixtures/fake-aioncore.js';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const CSP = "default-src 'none'; frame-ancestors 'self'; sandbox allow-scripts";

type FakeArtifacts = { port: number; seen: http.IncomingMessage[]; close: () => Promise<void> };

/** Answers like the artifact server: pages with its sandbox CSP, libraries as script. */
async function startFakeArtifacts(): Promise<FakeArtifacts> {
  const seen: http.IncomingMessage[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req);
    const lib = req.url?.startsWith('/lib/');
    res.writeHead(200, {
      'content-security-policy': CSP,
      'content-type': lib ? 'text/javascript' : 'text/html',
      'x-seen-url': req.url ?? '',
    });
    res.end(lib ? 'window.lib = 1;' : '<p>artifact</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const noCors = (headers: http.IncomingHttpHeaders): void =>
  expect(Object.keys(headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);

describe('artifact-view routes', () => {
  let backend: FakeBackend;
  let artifacts: FakeArtifacts;
  let handle: StaticServerHandle;
  let artifactPort: number | null;

  const start = async (routes: ArtifactViewRoutes | undefined): Promise<void> => {
    handle = await startStaticServer({
      staticDir: STATIC_DIR,
      backendPort: backend.port,
      port: 0,
      localRoutes: routes ? { artifactView: routes } : {},
    });
  };
  const get = (path: string, headers: Record<string, string> = {}) => request(handle.port, 'GET', path, headers);

  beforeEach(async () => {
    backend = await startFakeBackend();
    artifacts = await startFakeArtifacts();
    artifactPort = artifacts.port;
    await start({ port: () => artifactPort });
  });

  afterEach(async () => {
    await handle.stop();
    await artifacts.close();
    await backend.close();
  });

  it('refuses a page without a session and never reaches the artifact server', async () => {
    expect((await get(`/api/artifact-view/a/${ID}`)).status).toBe(401);
    expect((await get(`/api/artifact-view/a/${ID}/v/2`, { cookie: 'aionui-session=bad' })).status).toBe(401);
    expect(artifacts.seen).toHaveLength(0);
  });

  it("forwards a page with the artifact server's Host and no client cookie or auth header", async () => {
    const res = await get(`/api/artifact-view/a/${ID}/v/2?x=1`, {
      cookie: GOOD,
      authorization: 'Bearer good-token',
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe('<p>artifact</p>');
    expect(res.headers['content-security-policy']).toBe(CSP);
    noCors(res.headers);

    const [seen] = artifacts.seen;
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe(`/a/${ID}/v/2`);
    expect(seen.headers.host).toBe(`127.0.0.1:${artifacts.port}`);
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.origin).toBeUndefined();
    expect(backend.seen).toHaveLength(0);
  });

  it('serves a library without a session (sandboxed pages send none) and still forwards no cookie', async () => {
    const open = await get('/api/artifact-view/lib/react.js');
    expect(open.status).toBe(200);
    expect(open.body).toBe('window.lib = 1;');
    noCors(open.headers);

    expect((await get('/api/artifact-view/lib/react.js', { cookie: GOOD })).status).toBe(200);
    expect(artifacts.seen.map((r) => r.url)).toEqual(['/lib/react.js', '/lib/react.js']);
    expect(artifacts.seen.every((r) => r.headers.cookie === undefined)).toBe(true);
  });

  it.each([
    [`/api/artifact-view/a/short`, 404],
    [`/api/artifact-view/a/${ID}/v/0`, 404],
    [`/api/artifact-view/a/${ID}/x`, 404],
    [`/api/artifact-view/api/artifacts/get`, 404],
    [`/api/artifact-view/api/notes/list`, 404],
    [`/api/artifact-view`, 404],
    [`/api/artifact-view/lib/a%2e%2e`, 400],
    [`/api/artifact-view/lib/..%2fa`, 400],
    [`/api/ARTIFACT-VIEW/a/${ID}`, 404],
  ])('answers %s with %i, without reaching the artifact server or aioncore', async (path, status) => {
    expect((await get(path, { cookie: GOOD })).status).toBe(status);
    expect(artifacts.seen).toHaveLength(0);
    expect(backend.seen).toHaveLength(0);
  });

  it('refuses a library path the artifact server would not serve, even without a session', async () => {
    expect((await get('/api/artifact-view/lib/x/y.js')).status).toBe(401);
    expect((await get('/api/ARTIFACT-VIEW/lib/react.js')).status).toBe(404);
    expect(artifacts.seen).toHaveLength(0);
    expect(backend.seen).toHaveLength(0);
  });

  it.each([
    ['POST', `/api/artifact-view/a/${ID}`],
    ['POST', '/api/artifact-view/lib/react.js'],
    ['PUT', `/api/artifact-view/a/${ID}`],
    ['POST', '/api/artifact-view/api/artifacts/create'],
    ['POST', '/api/artifact-view/api/notes/add'],
  ])('refuses %s %s', async (method, path) => {
    const res = await request(handle.port, method, path, { cookie: GOOD });
    expect(res.status).toBe(405);
    expect(artifacts.seen).toHaveLength(0);
    expect(backend.seen).toHaveLength(0);
  });

  it('answers 503 while artifacts are unavailable, and 502 when the artifact server is gone', async () => {
    artifactPort = null;
    expect((await get(`/api/artifact-view/a/${ID}`, { cookie: GOOD })).status).toBe(503);
    artifactPort = artifacts.port;
    await artifacts.close();
    expect((await get(`/api/artifact-view/a/${ID}`, { cookie: GOOD })).status).toBe(502);
    artifacts = await startFakeArtifacts(); // afterEach closes it
  });

  it('never forwards the routes to aioncore when the desktop gave none', async () => {
    await handle.stop();
    await start(undefined);
    expect((await get('/api/artifact-view/lib/react.js')).status).toBe(503);
    expect((await get(`/api/artifact-view/a/${ID}`, { cookie: GOOD })).status).toBe(503);
    expect(backend.seen).toHaveLength(0);
  });
});
