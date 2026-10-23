/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const RELAY_HOST = '127.0.0.1';

/** Per-relay limits; tests shrink them. */
export type RelayLimits = {
  maxConnections: number;
  maxSessionsPerClient: number;
  maxInFlightPerSocket: number;
  /** Commands waiting behind the in-flight ones; beyond this they are refused. */
  maxQueuedPerSocket: number;
  /** Raw bytes of the waiting commands; beyond this new commands are refused (the socket stays open). */
  maxQueuedBytesPerSocket: number;
  maxBufferedBytes: number;
  /** How long a socket's send buffer may stay above `maxBufferedBytes` before it is closed. */
  bufferedGraceMs: number;
  maxTabsPerClient: number;
  createTargetsPerWindow: number;
  createTargetWindowMs: number;
  maxPayloadBytes: number;
};

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxConnections: 32,
  maxSessionsPerClient: 32,
  maxInFlightPerSocket: 16,
  maxQueuedPerSocket: 256,
  maxQueuedBytesPerSocket: 32 * 1024 * 1024,
  maxBufferedBytes: 16 * 1024 * 1024,
  bufferedGraceMs: 5000,
  maxTabsPerClient: 15,
  createTargetsPerWindow: 5,
  createTargetWindowMs: 10_000,
  maxPayloadBytes: 4 * 1024 * 1024,
};

const DEFAULT_LABEL = 'agent';
const MAX_LABEL_LENGTH = 40;
const BEARER_PREFIX = 'Bearer ';

/** `?client=` value reduced to `[\w .-]{1,40}`; 'agent' when nothing is left. */
export const sanitizeClientLabel = (raw: string | null): string =>
  (raw ?? '')
    .replace(/[^\w .-]/g, '')
    .trim()
    .slice(0, MAX_LABEL_LENGTH) || DEFAULT_LABEL;

/** Constant-time token check; hashing first makes the lengths equal. */
const tokensMatch = (expected: string, given: string): boolean =>
  timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(given).digest());

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A chat id as the MCP sends it in `X-Aion-Conversation`; undefined unless it matches `[A-Za-z0-9_-]{1,64}`. */
export const parseConversationId = (raw: unknown): string | undefined =>
  typeof raw === 'string' && CONVERSATION_ID.test(raw) ? raw : undefined;

export type UpgradeVerdict = { ok: true; label: string; conversationId?: string } | { ok: false; status: string };

/**
 * Vets a WebSocket upgrade, cheapest and most important check first: any `Origin` (a web page) is
 * refused, then a `Host` other than the relay's own address (DNS rebinding), then an unparsable url,
 * then a missing or wrong `Authorization: Bearer <token>`. A malformed `X-Aion-Conversation` is ignored, not refused.
 */
export function checkUpgrade(req: IncomingMessage, token: string, port: number): UpgradeVerdict {
  if (req.headers.origin !== undefined) return { ok: false, status: '403 Forbidden' };
  if (req.headers.host !== `${RELAY_HOST}:${port}`) return { ok: false, status: '403 Forbidden' };
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${RELAY_HOST}`);
  } catch {
    return { ok: false, status: '400 Bad Request' };
  }
  const auth = req.headers.authorization ?? '';
  const given = auth.startsWith(BEARER_PREFIX) ? auth.slice(BEARER_PREFIX.length) : '';
  if (!tokensMatch(token, given)) return { ok: false, status: '401 Unauthorized' };
  return {
    ok: true,
    label: sanitizeClientLabel(url.searchParams.get('client')),
    conversationId: parseConversationId(req.headers['x-aion-conversation']),
  };
}

/** Logs instead of crashing on errors of a raw upgrade socket (e.g. the peer reset it mid-handshake). */
export const guardUpgradeSocket = (socket: Duplex): void => {
  socket.on('error', (error) => console.warn('[AgentBrowserRelay] upgrade socket error:', error.message));
};

/** Ends a refused upgrade with a bare HTTP status. */
export const refuseUpgrade = (socket: Duplex, status: string): void => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

export type Params = Record<string, unknown>;
export type RelayRequest = { id: number; method: string; params: Params; sessionId?: string };

export const asParams = (value: unknown): Params | null =>
  value === undefined ? {} : value && typeof value === 'object' && !Array.isArray(value) ? (value as Params) : null;

/** Parses one client frame; null when it cannot even be replied to. */
export const parseRequest = (raw: string): RelayRequest | { id: number; invalid: string } | null => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const message = asParams(data);
  const id = message?.id;
  if (!message || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return null;
  const params = asParams(message.params);
  const { method, sessionId } = message;
  if (typeof method !== 'string' || !method || !params) return { id, invalid: 'Invalid request' };
  if (sessionId !== undefined && typeof sessionId !== 'string') return { id, invalid: 'Invalid sessionId' };
  return { id, method, params, sessionId: typeof sessionId === 'string' ? sessionId : undefined };
};

/** Sliding-window rate limit: the window with `now` added, or null when it is full. */
export const takeSlot = (times: readonly number[], limit: number, windowMs: number, now: number): number[] | null => {
  const recent = times.filter((at) => now - at < windowMs);
  return recent.length >= limit ? null : [...recent, now];
};
