/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ARTIFACT_LIMITS, type ArtifactResult, type ArtifactVersion } from '@/common/types/agent/artifacts';
import type { ArtifactStore } from './store';

export type ArtifactServer = {
  origin: string;
  port: number;
  url(id: string, version?: number): string;
  close(): Promise<void>;
};

export type ArtifactServerOptions = {
  store: ArtifactStore;
  token: string;
  renderPage: (v: ArtifactVersion) => string;
  /** Folder with the bundled libraries and their `manifest.json`; null serves none. */
  libsDir: string | null;
  /** 0 (the default) picks a free port. */
  port?: number;
};

const HOST = '127.0.0.1';

export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'";

/** Sent on every response. No CORS headers, ever: other origins must not read anything. */
const SECURITY_HEADERS = {
  'Content-Security-Policy': ARTIFACT_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** Content plus room for the JSON envelope and the other fields. */
const MAX_BODY_BYTES = ARTIFACT_LIMITS.maxContentBytes + 64 * 1024;
/** Past this the upload is cut off instead of drained to its end. */
const MAX_DRAIN_BYTES = 4 * MAX_BODY_BYTES;
const PAGE_RE = /^\/a\/([A-Za-z0-9_-]{22})(?:\/v\/([1-9]\d{0,8}))?$/;
const LIB_RE = /^\/lib\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})$/;
const API_RE = /^\/api\/artifacts\/(create|update|get)$/;
const LIB_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const HTML_TYPE = 'text/html; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const wrapperPage = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
  '<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:100%}</style>' +
  `</head><body>${body}</body></html>`;

/**
 * Renders an artifact version as a page: html as written, svg inside an `<img>` wrapper (never inline).
 * Other kinds get a placeholder until their bundled renderers ship.
 */
export function renderArtifactPage(v: ArtifactVersion): string {
  if (v.kind === 'html') return v.content;
  if (v.kind === 'svg') {
    const src = `data:image/svg+xml;base64,${Buffer.from(v.content, 'utf8').toString('base64')}`;
    return wrapperPage(v.title, `<img src="${src}" alt="${escapeHtml(v.title)}">`);
  }
  return wrapperPage(v.title, `<p>This kind of artifact (${v.kind}) is not available yet.</p>`);
}

/** Constant-time token check; hashing first makes the lengths equal. */
const tokenMatches = (expected: string, header: string | undefined): boolean => {
  const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return given.length > 0 && timingSafeEqual(digest(expected), digest(given));
};

const send = (res: ServerResponse, status: number, type: string, body: string | Buffer): void => {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
};
const sendJson = (res: ServerResponse, status: number, body: unknown): void =>
  send(res, status, JSON_TYPE, JSON.stringify(body));
const badRequest = (message: string) => ({ ok: false as const, error: 'bad-content' as const, message });

class BodyTooLarge extends Error {}

/**
 * Reads the request body. Past the cap it stops buffering and rejects with BodyTooLarge once the
 * client is done, so the client still gets its 413; an upload that runs on far past the cap is cut off.
 */
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else if (size > MAX_DRAIN_BYTES) req.destroy();
    });
    req.on('end', () =>
      size > MAX_BODY_BYTES ? reject(new BodyTooLarge()) : resolve(Buffer.concat(chunks).toString('utf8'))
    );
    req.on('close', () => reject(new BodyTooLarge())); // no-op once settled
    req.on('error', reject);
  });

type ApiBody = Record<string, unknown> & { conversationId: string };

const callStore = (
  store: ArtifactStore,
  op: string,
  b: ApiBody
): Promise<ArtifactResult<ArtifactVersion>> | ReturnType<typeof badRequest> => {
  if (op === 'create') {
    return store.create(b.conversationId, {
      title: b.title as string,
      kind: b.kind as ArtifactVersion['kind'],
      content: b.content as string,
    });
  }
  if (typeof b.id !== 'string') return badRequest('id must be a string');
  if (op === 'update') {
    return store.update(b.conversationId, b.id, { content: b.content as string, title: b.title as string | undefined });
  }
  if (b.version !== undefined && typeof b.version !== 'number') return badRequest('version must be a number');
  return store.get(b.conversationId, b.id, b.version as number | undefined);
};

/**
 * Starts the loopback artifact server: rendered pages at `/a/<id>[/v/<n>]`, allowlisted libraries at
 * `/lib/<file>`, and the bearer-token JSON API at `POST /api/artifacts/{create,update,get}`. Rejects
 * when the port can't be bound.
 */
export async function startArtifactServer(opts: ArtifactServerOptions): Promise<ArtifactServer> {
  const { store, token, renderPage, libsDir } = opts;
  let port = 0;

  const servePage = async (res: ServerResponse, id: string, n: string | undefined): Promise<void> => {
    const result = await store.getById(id, n === undefined ? undefined : Number(n));
    if (result.ok) return send(res, 200, HTML_TYPE, renderPage(result.value));
    if ('error' in result && result.error === 'not-found') return send(res, 404, TEXT_TYPE, 'Not found');
    send(res, 500, TEXT_TYPE, "Couldn't load the artifact");
  };

  const serveLib = async (res: ServerResponse, file: string): Promise<void> => {
    const type = LIB_TYPES[path.extname(file)];
    if (!libsDir || !type) return send(res, 404, TEXT_TYPE, 'Not found');
    const manifest: unknown = JSON.parse(await fs.readFile(path.join(libsDir, 'manifest.json'), 'utf8'));
    if (typeof manifest !== 'object' || manifest === null || !Object.hasOwn(manifest, file)) {
      return send(res, 404, TEXT_TYPE, 'Not found');
    }
    send(res, 200, type, await fs.readFile(path.join(libsDir, file)));
  };

  const serveApi = async (req: IncomingMessage, res: ServerResponse, op: string): Promise<void> => {
    if (!tokenMatches(token, req.headers.authorization)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'Missing or wrong token' });
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (!(e instanceof BodyTooLarge)) return sendJson(res, 400, badRequest('Body must be JSON'));
      return sendJson(res, 413, { ok: false, error: 'too-large', message: `Body exceeds ${MAX_BODY_BYTES} bytes` });
    }
    const b = body as Partial<ApiBody> | null;
    if (typeof b !== 'object' || b === null || Array.isArray(b) || typeof b.conversationId !== 'string') {
      return sendJson(res, 400, badRequest('Body must be an object with a conversationId'));
    }
    // Store results, failures included, are the API's answer; only malformed requests get a 4xx.
    sendJson(res, 200, await callStore(store, op, b as ApiBody));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Host first, before anything else: blocks DNS rebinding.
    const host = req.headers.host;
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return send(res, 400, TEXT_TYPE, 'Bad host');
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, TEXT_TYPE, 'Method not allowed');
    }
    // The raw path, never URL-normalised: `..` and percent-escapes simply fail to match.
    const pathname = (req.url ?? '').split('?')[0];
    const pageMatch = req.method === 'GET' ? PAGE_RE.exec(pathname) : null;
    if (pageMatch) return servePage(res, pageMatch[1], pageMatch[2]);
    const libMatch = req.method === 'GET' ? LIB_RE.exec(pathname) : null;
    if (libMatch) return serveLib(res, libMatch[1]);
    const apiMatch = req.method === 'POST' ? API_RE.exec(pathname) : null;
    if (apiMatch) return serveApi(req, res, apiMatch[1]);
    send(res, 404, TEXT_TYPE, 'Not found');
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error('[artifacts] request failed', e);
      if (!res.headersSent) send(res, 500, TEXT_TYPE, 'Internal error');
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://${HOST}:${port}`;

  return {
    origin,
    port,
    url: (id, version) => `${origin}/a/${id}${version === undefined ? '' : `/v/${version}`}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
