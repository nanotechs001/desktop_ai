/**
 * The phone's agent confirmations: `GET /api/browser-view/confirms?conversation=<id>` and
 * `POST /api/browser-view/confirms/<id>`. Both go through the auth gate; the list follows the tabs route's
 * Origin rule, an answer needs a matching `Origin`. Real TCP listener, the fake aioncore and fake confirm routes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { startStaticServer, type StaticServerHandle } from '../src/static-server.js';
import type { BrowserConfirm, BrowserConfirmRoutes } from '../src/types.js';
import { GOOD, request, startFakeBackend, STATIC_DIR, type FakeBackend } from './fixtures/fake-aioncore.js';

const ID = '0b8f3c1e-6a3d-4c2b-9f4e-1d2c3b4a5f60';
const ASK: BrowserConfirm = { id: ID, origin: 'https://shop.test', frameOrigin: 'https://shop.test', label: 'Pay' };

function fakeConfirms(): BrowserConfirmRoutes & { open: Set<string> } {
  const open = new Set([ID]);
  return {
    open,
    listConfirms: vi.fn((conversationId: string) => (conversationId === 'conv-1' && open.has(ID) ? [ASK] : [])),
    answerConfirm: vi.fn((id: string) => open.delete(id)),
  };
}

/** A request with a body, which the fixture's `request` cannot send. */
function send(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const corsHeaders = (headers: http.IncomingHttpHeaders): string[] =>
  Object.keys(headers).filter((h) => h.startsWith('access-control-'));

describe('browser-view confirm routes', () => {
  let backend: FakeBackend;
  let confirms: ReturnType<typeof fakeConfirms>;
  let handle: StaticServerHandle;
  let origin: string;

  beforeEach(async () => {
    backend = await startFakeBackend();
    confirms = fakeConfirms();
    handle = await startStaticServer({
      staticDir: STATIC_DIR,
      backendPort: backend.port,
      port: 0,
      localRoutes: { browserConfirms: confirms },
    });
    origin = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    await backend.close();
  });

  const answer = (body: string, headers: Record<string, string> = { cookie: GOOD, origin }, id = ID) =>
    send(
      handle.port,
      'POST',
      `/api/browser-view/confirms/${id}`,
      { 'content-type': 'application/json', ...headers },
      body
    );

  it('without a session both routes are 401 and never reach the desktop', async () => {
    const list = await request(handle.port, 'GET', '/api/browser-view/confirms?conversation=conv-1', { origin });
    const post = await answer('{"allow":true,"always":false}', { origin });
    expect([list.status, post.status]).toEqual([401, 401]);
    expect(confirms.listConfirms).not.toHaveBeenCalled();
    expect(confirms.answerConfirm).not.toHaveBeenCalled();
    expect(backend.seen.filter((s) => s.url.startsWith('/api/browser-view'))).toEqual([]);
  });

  it("GET lists the chat's asks without CORS headers, same-origin by Origin or Sec-Fetch-Site", async () => {
    const byOrigin = await request(handle.port, 'GET', '/api/browser-view/confirms?conversation=conv-1', {
      cookie: GOOD,
      origin,
    });
    expect(byOrigin.status).toBe(200);
    expect(JSON.parse(byOrigin.body)).toEqual({ confirms: [ASK] });
    expect(corsHeaders(byOrigin.headers)).toEqual([]);

    const byFetchSite = await request(handle.port, 'GET', '/api/browser-view/confirms?conversation=conv-2', {
      cookie: GOOD,
      'sec-fetch-site': 'same-origin',
    });
    expect(JSON.parse(byFetchSite.body)).toEqual({ confirms: [] });
  });

  it.each([
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['no Origin and a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
  ])('GET with %s is 403', async (_name, extra) => {
    const r = await request(handle.port, 'GET', '/api/browser-view/confirms?conversation=conv-1', {
      cookie: GOOD,
      ...extra,
    });
    expect(r.status).toBe(403);
    expect(corsHeaders(r.headers)).toEqual([]);
    expect(confirms.listConfirms).not.toHaveBeenCalled();
  });

  it('GET without exactly one valid conversation is 400', async () => {
    for (const query of ['', '?conversation=a/b', '?conversation=a&conversation=b']) {
      const r = await request(handle.port, 'GET', `/api/browser-view/confirms${query}`, { cookie: GOOD, origin });
      expect(r.status, query).toBe(400);
    }
  });

  it('POST answers once with 204, then 404 for the same id', async () => {
    const first = await answer('{"allow":true,"always":true}');
    expect(first.status).toBe(204);
    expect(corsHeaders(first.headers)).toEqual([]);
    expect(confirms.answerConfirm).toHaveBeenCalledWith(ID, true, true);

    expect((await answer('{"allow":false,"always":false}')).status).toBe(404);
  });

  it.each([
    ['no Origin, even with Sec-Fetch-Site: same-origin', { cookie: GOOD, 'sec-fetch-site': 'same-origin' }],
    ['a foreign Origin', { cookie: GOOD, origin: 'https://evil.example' }],
  ])('POST with %s is 403', async (_name, headers) => {
    expect((await answer('{"allow":true,"always":false}', headers)).status).toBe(403);
    expect(confirms.answerConfirm).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{allow:true'],
    ['a missing field', '{"allow":true}'],
    ['a non-boolean', '{"allow":"yes","always":false}'],
    ['an extra field', '{"allow":true,"always":false,"origin":"x"}'],
  ])('POST with %s is 400', async (_name, body) => {
    expect((await answer(body)).status).toBe(400);
    expect(confirms.answerConfirm).not.toHaveBeenCalled();
  });

  it('POST with a body over 1 KB is refused without answering', async () => {
    const big = JSON.stringify({ allow: true, always: false, pad: 'x'.repeat(2048) });
    expect((await answer(big)).status).toBe(413);
    expect(confirms.answerConfirm).not.toHaveBeenCalled();
  });

  it('POST to a malformed id is 404, and GET on an answer path is 405', async () => {
    expect((await answer('{"allow":true,"always":false}', undefined, 'not-a-uuid')).status).toBe(404);
    const r = await request(handle.port, 'GET', `/api/browser-view/confirms/${ID}`, { cookie: GOOD, origin });
    expect(r.status).toBe(405);
    expect(confirms.answerConfirm).not.toHaveBeenCalled();
  });
});
