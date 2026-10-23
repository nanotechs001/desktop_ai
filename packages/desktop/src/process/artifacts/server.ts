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
import {
  ARTIFACT_LIMITS,
  NOTE_LIMITS,
  type ArtifactResult,
  type ArtifactVersion,
} from '@/common/types/agent/artifacts';
import type { MemoryApiHandler } from './memory/memoryApi';
import type { NotesApi } from './notes';
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
  /** `libBase` is the page's way to `/lib/`, relative to its path. */
  renderPage: (v: ArtifactVersion, libBase: string) => string;
  /** Folder with the bundled libraries and their `manifest.json`; null serves none. */
  libsDir: string | null;
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Serves `POST /api/notes/add` when given. */
  notes?: NotesApi;
  /** Serves `POST /api/memory/{search,read,save,log,retire}` when given. */
  memory?: MemoryApiHandler;
};

const HOST = '127.0.0.1';

/**
 * The plan's artifact CSP, verbatim, plus `sandbox` (ruling N-14): every page gets an opaque origin of its own, so
 * artifacts share no storage or cookies and can't reach into each other's DOM.
 */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'" +
  '; sandbox allow-scripts allow-popups allow-modals allow-downloads';

/** Sent on every response. No CORS headers, ever: other origins must not read anything. */
const SECURITY_HEADERS = {
  'Content-Security-Policy': ARTIFACT_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/**
 * Twice the content limit plus room for the other fields: JSON escaping can double near-limit content (every quote,
 * backslash or control character costs two bytes or more). The store enforces the real content limit after parsing.
 */
export const MAX_BODY_BYTES = 2 * ARTIFACT_LIMITS.maxContentBytes + 64 * 1024;
/** Past this the upload is cut off instead of drained to its end. */
export const MAX_DRAIN_BYTES = 4 * MAX_BODY_BYTES;
const PAGE_RE = /^\/a\/([A-Za-z0-9_-]{22})(?:\/v\/([1-9]\d{0,8}))?$/;
const LIB_RE = /^\/lib\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,127})$/;
const API_RE = /^\/api\/artifacts\/(create|update|get)$/;
const NOTES_RE = /^\/api\/notes\/(add|list|update|delete)$/;
const MEMORY_RE = /^\/api\/memory\/(search|read|save|log|retire)$/;
const LIB_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const HTML_TYPE = 'text/html; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

/** Constant-time token check; hashing first makes the lengths equal. */
const tokenMatches = (expected: string, header: string | undefined): boolean => {
  const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return given.length > 0 && timingSafeEqual(digest(expected), digest(given));
};

const send = (
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  headers: Record<string, string> = {}
): void => {
  res
    .writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...headers })
    .end(body);
};
const sendJson = (res: ServerResponse, status: number, body: unknown): void =>
  send(res, status, JSON_TYPE, JSON.stringify(body));
const badRequest = (message: string) => ({ ok: false as const, error: 'bad-content' as const, message });

/** The request body went past the cap. */
export class BodyTooLarge extends Error {}

/**
 * Reads the request body. Past the cap it stops buffering and rejects with BodyTooLarge once the
 * client is done, so the client still gets its 413; an upload that runs on far past the cap is cut off.
 * A client that hangs up first gets an abort error.
 */
export const readBody = (req: IncomingMessage): Promise<string> =>
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
    // A no-op once settled.
    req.on('close', () =>
      reject(size > MAX_BODY_BYTES ? new BodyTooLarge() : new Error('Request aborted by the client'))
    );
    req.on('error', reject);
  });

/** `manifest.json` (file -> sha256) of the bundled libraries; empty, with a warning, when it can't be read. */
const readManifest = async (libsDir: string): Promise<Record<string, string>> => {
  try {
    const manifest: unknown = JSON.parse(await fs.readFile(path.join(libsDir, 'manifest.json'), 'utf8'));
    if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
      return manifest as Record<string, string>;
    }
    console.warn('[artifacts] the library manifest is malformed; serving no libraries');
  } catch (error) {
    console.warn('[artifacts] no library manifest; serving no libraries', error);
  }
  return {};
};

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

/** The old `add` tool: saves a note for the chat's Agent; the Agent comes from the conversation, never from the body. */
const addNote = async (notes: NotesApi, adds: Map<string, number>, b: ApiBody): Promise<unknown> => {
  if (typeof b.text !== 'string') return badRequest('text must be a string');
  if (b.fromPage !== undefined && typeof b.fromPage !== 'boolean') return badRequest('fromPage must be a boolean');
  // Reserved before the first await so parallel calls can't overshoot; a refused add gives its slot back.
  const used = adds.get(b.conversationId) ?? 0;
  if (used >= NOTE_LIMITS.maxAddsPerConversation) {
    return {
      ok: false,
      error: 'limit-reached',
      message: `A chat saves at most ${NOTE_LIMITS.maxAddsPerConversation} notes`,
    };
  }
  adds.set(b.conversationId, used + 1);
  const agent = await notes.resolveAgent(b.conversationId);
  const result =
    agent.ok === false
      ? { ok: false as const, error: 'not-found' as const, message: agent.message }
      : await notes.add(agent.agentId, b.text, b.fromPage ? 'page' : 'agent');
  if (!result.ok) adds.set(b.conversationId, (adds.get(b.conversationId) ?? 1) - 1);
  return result;
};

/**
 * Starts the loopback artifact server: rendered pages at `/a/<id>[/v/<n>]`, allowlisted libraries at
 * `/lib/<file>`, and the bearer-token JSON API at `POST /api/artifacts/{create,update,get}` and `POST /api/notes/add`
 * (list, update and delete answer 403: agents only add notes; the user edits them over IPC). Rejects
 * when the port can't be bound.
 */
export async function startArtifactServer(opts: ArtifactServerOptions): Promise<ArtifactServer> {
  const { store, token, renderPage, libsDir } = opts;
  let port = 0;
  /** Notes added per conversation since the server started. */
  const noteAdds = new Map<string, number>();

  const servePage = async (res: ServerResponse, id: string, n: string | undefined): Promise<void> => {
    const result = await store.getById(id, n === undefined ? undefined : Number(n));
    // Relative, so a page reached through the WebUI's /api/artifact-view/ prefix loads its libraries there too.
    const libBase = n === undefined ? '../lib/' : '../../../lib/';
    if (result.ok) return send(res, 200, HTML_TYPE, renderPage(result.value, libBase));
    if ('error' in result && result.error === 'not-found') return send(res, 404, TEXT_TYPE, 'Not found');
    send(res, 500, TEXT_TYPE, "Couldn't load the artifact");
  };

  // Read once: the libraries don't change while the app runs. A missing or broken manifest serves none.
  const manifest = libsDir ? await readManifest(libsDir) : {};
  const libCache = new Map<string, Promise<Buffer>>();

  const serveLib = async (res: ServerResponse, file: string): Promise<void> => {
    const type = LIB_TYPES[path.extname(file)];
    if (!libsDir || !type || !Object.hasOwn(manifest, file)) return send(res, 404, TEXT_TYPE, 'Not found');
    let body = libCache.get(file);
    if (!body) {
      body = fs.readFile(path.join(libsDir, file));
      libCache.set(file, body);
      body.catch(() => libCache.delete(file)); // a failed read is retried next time
    }
    // Sandboxed pages have opaque origins, so for them every library is a cross-origin load.
    send(res, 200, type, await body, { 'Cross-Origin-Resource-Policy': 'cross-origin' });
  };

  /** Token, then body, then `run`; a null `run` is a route token callers may not use. */
  const serveApi = async (
    req: IncomingMessage,
    res: ServerResponse,
    run: ((b: ApiBody) => Promise<unknown>) | null
  ): Promise<void> => {
    if (!tokenMatches(token, req.headers.authorization)) {
      return sendJson(res, 401, { ok: false, error: 'unauthorized', message: 'Missing or wrong token' });
    }
    if (!run) {
      return sendJson(res, 403, {
        ok: false,
        error: 'forbidden',
        message: 'Only the user can list, edit or delete notes',
      });
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
    sendJson(res, 200, await run(b as ApiBody));
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
    if (apiMatch) return serveApi(req, res, async (b) => callStore(store, apiMatch[1], b));
    const notes = opts.notes;
    const notesMatch = req.method === 'POST' && notes ? NOTES_RE.exec(pathname) : null;
    if (notes && notesMatch)
      return serveApi(req, res, notesMatch[1] === 'add' ? (b) => addNote(notes, noteAdds, b) : null);
    const memory = opts.memory;
    const memoryMatch = req.method === 'POST' && memory ? MEMORY_RE.exec(pathname) : null;
    if (memory && memoryMatch) return serveApi(req, res, (b) => memory(memoryMatch[1], b));
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
