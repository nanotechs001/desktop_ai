/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtifactStore } from '@process/artifacts/store';
import { renderArtifactPage } from '@process/artifacts/pages';
import { ARTIFACT_CSP, startArtifactServer, type ArtifactServer } from '@process/artifacts/server';

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuv';
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'" +
    // Ruling N-14: every page is its own opaque origin.
    '; sandbox allow-scripts allow-popups allow-modals allow-downloads',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
};

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string };

/** Raw node:http request so the test controls the Host header (fetch forbids setting it). */
const request = (
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer; host?: string }
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: opts.host ?? '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.end(opts.body);
  });

describe('artifact server', () => {
  let root: string;
  let server: ArtifactServer;

  const api = (op: string, body: unknown, token = TOKEN) =>
    request(server.port, {
      method: 'POST',
      path: `/api/artifacts/${op}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const page = (p: string) => request(server.port, { path: p });

  const create = async (input: { title: string; kind: string; content: string }, conversationId = 'conv1') => {
    const reply = await api('create', { conversationId, ...input });
    expect(reply.status).toBe(200);
    const result = JSON.parse(reply.body) as { ok: boolean; value: { id: string; version: number } };
    expect(result.ok).toBe(true);
    return result.value;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-server-'));
    server = await startArtifactServer({
      store: createArtifactStore(root),
      token: TOKEN,
      renderPage: renderArtifactPage,
      libsDir: null,
    });
  });

  afterEach(async () => {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('binds 127.0.0.1 only', async () => {
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.url('abc')).toBe(`${server.origin}/a/abc`);
    expect(server.url('abc', 2)).toBe(`${server.origin}/a/abc/v/2`);
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    const attempts = ['::1', ...(external ? [external] : [])].map(
      (host) =>
        new Promise((resolve, reject) => {
          const socket = net.connect({ host, port: server.port }, () => {
            socket.destroy();
            resolve('connected');
          });
          socket.on('error', reject);
        })
    );
    await Promise.all(attempts.map((attempt) => expect(attempt).rejects.toThrow()));
  });

  it('wrong Host header → 400; localhost:<port> and 127.0.0.1:<port> accepted', async () => {
    const { id } = await create({ title: 'T', kind: 'html', content: '<p>hi</p>' });
    const statusFor = async (host: string) =>
      [host, (await request(server.port, { path: `/a/${id}`, headers: { host } })).status] as const;
    const bad = ['evil.example', `evil.example:${server.port}`, '127.0.0.1', `127.0.0.1:${server.port + 1}`];
    expect(await Promise.all(bad.map(statusFor))).toEqual(bad.map((h) => [h, 400]));
    // Host is checked before the token.
    expect(
      (await request(server.port, { method: 'POST', path: '/api/artifacts/get', headers: { host: 'evil.example' } }))
        .status
    ).toBe(400);
    const good = [`localhost:${server.port}`, `127.0.0.1:${server.port}`];
    expect(await Promise.all(good.map(statusFor))).toEqual(good.map((h) => [h, 200]));
  });

  it('API without or with a wrong bearer token → 401', async () => {
    const body = JSON.stringify({ conversationId: 'conv1', title: 'T', kind: 'html', content: 'x' });
    const noAuth = await request(server.port, { method: 'POST', path: '/api/artifacts/create', body });
    expect(noAuth.status).toBe(401);
    expect((await api('create', JSON.parse(body), 'wrong')).status).toBe(401);
    expect((await api('create', JSON.parse(body), `${TOKEN}x`)).status).toBe(401);
    const basic = await request(server.port, {
      method: 'POST',
      path: '/api/artifacts/create',
      headers: { authorization: `Basic ${TOKEN}` },
      body,
    });
    expect(basic.status).toBe(401);
    // Nothing was created.
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('every /a/ response carries the exact CSP and security headers', async () => {
    expect(ARTIFACT_CSP).toBe(SECURITY_HEADERS['content-security-policy']);
    const { id } = await create({ title: 'T', kind: 'html', content: '<p>hi</p>' });
    const svg = await create({ title: 'S', kind: 'svg', content: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    const md = await create({ title: 'M', kind: 'markdown', content: '# hi' });
    const replies = await Promise.all(
      [`/a/${id}`, `/a/${id}/v/1`, `/a/${svg.id}`, `/a/${md.id}`, `/a/${id}/v/9`, '/a/AAAAAAAAAAAAAAAAAAAAAA'].map(page)
    );
    for (const reply of replies) {
      expect(reply.headers).toMatchObject(SECURITY_HEADERS);
      expect(reply.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('/a/<unknown> and /a/<id>/v/<missing> → 404; ../ and encoded traversal → 404', async () => {
    const { id } = await create({ title: 'T', kind: 'html', content: '<p>hi</p>' });
    const paths = [
      '/a/AAAAAAAAAAAAAAAAAAAAAA',
      '/a/short',
      `/a/${id}/v/2`,
      `/a/${id}/v/0`,
      `/a/${id}/v/-1`,
      `/a/${id}/v/1.5`,
      `/a/${id}/`,
      `/a/${id}/../${id}`,
      `/a/../conv1/${id}/v1.html`,
      `/a/%2e%2e/conv1/${id}/meta.json`,
      `/a/..%2fconv1%2f${id}`,
      '/lib/react.js',
      '/lib/../package.json',
      '/',
      '/api/artifacts/create',
    ];
    expect(await Promise.all(paths.map(async (p) => [p, (await page(p)).status]))).toEqual(paths.map((p) => [p, 404]));
    expect((await request(server.port, { method: 'PUT', path: `/a/${id}` })).status).toBe(405);
    expect((await request(server.port, { method: 'OPTIONS', path: '/api/artifacts/create' })).status).toBe(405);
  });

  it('create → GET /a/<id> returns the html; update → /a/<id> shows v2, /a/<id>/v/1 shows v1', async () => {
    const { id, version } = await create({ title: 'Dash', kind: 'html', content: '<h1>v1</h1>' });
    expect(version).toBe(1);
    const v1 = await page(`/a/${id}`);
    expect(v1.status).toBe(200);
    expect(v1.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(v1.body).toBe('<h1>v1</h1>');

    const updated = await api('update', { conversationId: 'conv1', id, content: '<h1>v2</h1>' });
    expect(JSON.parse(updated.body)).toMatchObject({ ok: true, value: { id, version: 2 } });
    expect((await page(`/a/${id}`)).body).toBe('<h1>v2</h1>');
    expect((await page(`/a/${id}/v/1`)).body).toBe('<h1>v1</h1>');

    const got = await api('get', { conversationId: 'conv1', id, version: 1 });
    expect(JSON.parse(got.body)).toMatchObject({ ok: true, value: { id, version: 1, content: '<h1>v1</h1>' } });
    // Another conversation cannot read or update it.
    expect(JSON.parse((await api('get', { conversationId: 'conv2', id })).body)).toMatchObject({
      ok: false,
      error: 'not-found',
    });
    expect(JSON.parse((await api('update', { conversationId: 'conv2', id, content: 'x' })).body)).toMatchObject({
      ok: false,
      error: 'not-found',
    });
    // Malformed bodies are rejected without a stack trace.
    const malformed = ['not json', '[]', JSON.stringify({ id })].map((body) =>
      request(server.port, {
        method: 'POST',
        path: '/api/artifacts/get',
        headers: { authorization: `Bearer ${TOKEN}` },
        body,
      })
    );
    for (const reply of await Promise.all(malformed)) {
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body)).toMatchObject({ ok: false, error: 'bad-content' });
      expect(reply.body).not.toMatch(/at .*\.ts/);
    }
  });

  it('svg renders inside a wrapper page, not served raw', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
    const { id } = await create({ title: 'Logo <b>', kind: 'svg', content: svg });
    const reply = await page(`/a/${id}`);
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(reply.body).not.toContain('<svg');
    expect(reply.body).toContain(`src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"`);
    expect(reply.body).toContain('Logo &lt;b&gt;');
  });

  it('oversized body → 413, server keeps serving', async () => {
    const auth = { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${TOKEN}` };
    /** Streams `chunks` x 256 KB and resolves with the status; the server may cut the upload short. */
    const upload = (headers: Record<string, string | number>, chunks: number) =>
      new Promise<number>((resolve, reject) => {
        let answered = false;
        const req = http.request(
          { host: '127.0.0.1', port: server.port, method: 'POST', path: '/api/artifacts/create', headers },
          (res) => {
            answered = true;
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on('error', (e) => (answered ? undefined : reject(e)));
        const chunk = Buffer.alloc(256 * 1024, 'x');
        const pump = (left: number): void => {
          if (left === 0 || req.destroyed) return void req.end();
          if (req.write(chunk)) pump(left - 1);
          else req.once('drain', () => pump(left - 1));
        };
        pump(chunks);
      });
    expect(await upload({ ...auth, 'content-length': 12 * 256 * 1024 }, 12)).toBe(413);
    expect(await upload({ ...auth, 'transfer-encoding': 'chunked' }, 12)).toBe(413);
    // An upload that keeps going far past the cap is cut off rather than drained.
    await expect(upload({ ...auth, 'transfer-encoding': 'chunked' }, 48)).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual([]);
    const { id } = await create({ title: 'T', kind: 'html', content: '<p>still up</p>' });
    expect((await page(`/a/${id}`)).body).toBe('<p>still up</p>');
  });

  it('/lib/<file> reads each library from disk once', async () => {
    const libs = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-libs-'));
    try {
      await fs.writeFile(path.join(libs, 'manifest.json'), JSON.stringify({ 'react.js': 'abc' }));
      await fs.writeFile(path.join(libs, 'react.js'), 'window.React = {};');
      const withLibs = await startArtifactServer({
        store: createArtifactStore(root),
        token: TOKEN,
        renderPage: renderArtifactPage,
        libsDir: libs,
      });
      const reads = vi.spyOn(fs, 'readFile');
      try {
        const first = await request(withLibs.port, { path: '/lib/react.js' });
        const second = await request(withLibs.port, { path: '/lib/react.js' });
        expect([first.body, second.body]).toEqual(['window.React = {};', 'window.React = {};']);
        expect(reads.mock.calls.map(([file]) => file)).toEqual([path.join(libs, 'react.js')]);
      } finally {
        reads.mockRestore();
        await withLibs.close();
      }
    } finally {
      await fs.rm(libs, { recursive: true, force: true });
    }
  });

  it('/lib/<file> serves only files listed in the manifest', async () => {
    const libs = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-libs-'));
    try {
      await fs.writeFile(path.join(libs, 'manifest.json'), JSON.stringify({ 'react.js': 'abc' }));
      await fs.writeFile(path.join(libs, 'react.js'), 'window.React = {};');
      await fs.writeFile(path.join(libs, 'secret.js'), 'nope');
      const withLibs = await startArtifactServer({
        store: createArtifactStore(root),
        token: TOKEN,
        renderPage: renderArtifactPage,
        libsDir: libs,
      });
      try {
        const lib = await request(withLibs.port, { path: '/lib/react.js' });
        expect(lib.status).toBe(200);
        expect(lib.headers['content-type']).toBe('text/javascript; charset=utf-8');
        // Sandboxed (opaque-origin) pages must be able to load the libraries.
        expect(lib.headers).toMatchObject({ ...SECURITY_HEADERS, 'cross-origin-resource-policy': 'cross-origin' });
        expect(lib.body).toBe('window.React = {};');
        const hidden = ['/lib/secret.js', '/lib/manifest.json', '/lib/..%2fmanifest.json', '/lib/x/react.js'];
        const statuses = await Promise.all(
          hidden.map(async (p) => [p, (await request(withLibs.port, { path: p })).status])
        );
        expect(statuses).toEqual(hidden.map((p) => [p, 404]));
      } finally {
        await withLibs.close();
      }
    } finally {
      await fs.rm(libs, { recursive: true, force: true });
    }
  });
});
