/**
 * WebUI auth gate: pure rules for the WebUI listener (no sockets, no Electron).
 * Decides which requests need a session, validates sessions against aioncore
 * with a small cache, and builds trustworthy forwarding headers.
 */

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const GATE_LIMITS = { ttlMs: 30_000, max: 500, headerMaxBytes: 16_384 } as const;

export type GateDecision = 'open' | 'blocked' | 'auth';

// Desktop-only aioncore routes; the WebUI never needs them.
const BLOCKED_PREFIXES = ['/api/webui', '/api/auth/internal'];
const OPEN_ROUTES = new Set([
  'POST /login',
  'POST /logout',
  'POST /api/auth/qr-login',
  'GET /api/auth/status',
  'POST /api/auth/refresh',
]);

/** Query stripped, percent-decoded, `//` collapsed, `.`/`..` resolved (never above root), lowercased. null = reject. */
function normalizePath(rawPath: string): string | null {
  const pathOnly = rawPath.split(/[?#]/, 1)[0];
  if (!pathOnly.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return '/' + segments.join('/').toLowerCase();
}

const isUnder = (path: string, prefix: string): boolean => path === prefix || path.startsWith(prefix + '/');

export function classifyRequest(method: string, rawPath: string): GateDecision {
  const path = normalizePath(rawPath);
  if (path === null || BLOCKED_PREFIXES.some((p) => isUnder(path, p))) return 'blocked';
  if (OPEN_ROUTES.has(`${method.toUpperCase()} ${path}`)) return 'open';
  if (isUnder(path, '/api') || isUnder(path, '/ws')) return 'auth';
  return 'open';
}

type SessionHeaders = { cookie?: string; authorization?: string };

export type SessionValidator = (headers: SessionHeaders) => Promise<'valid' | 'invalid' | 'unavailable'>;

export function createSessionValidator(
  fetchUser: (headers: SessionHeaders) => Promise<number>,
  opts: { ttlMs?: number; max?: number; now?: () => number } = {}
): SessionValidator {
  const { ttlMs = GATE_LIMITS.ttlMs, max = GATE_LIMITS.max, now = Date.now } = opts;
  const validUntil = new Map<string, number>(); // insertion order = LRU order

  return async (headers) => {
    if (!headers.cookie && !headers.authorization) return 'invalid';
    const key = createHash('sha256')
      .update(`${headers.cookie ?? ''}\n${headers.authorization ?? ''}`)
      .digest('hex');

    const expiry = validUntil.get(key);
    if (expiry !== undefined) {
      validUntil.delete(key);
      if (expiry > now()) {
        validUntil.set(key, expiry);
        return 'valid';
      }
    }

    let status: number;
    try {
      status = await fetchUser(headers);
    } catch {
      return 'unavailable';
    }
    if (status >= 200 && status < 300) {
      validUntil.set(key, now() + ttlMs);
      while (validUntil.size > max) validUntil.delete(validUntil.keys().next().value as string);
      return 'valid';
    }
    return status === 401 || status === 403 ? 'invalid' : 'unavailable';
  };
}

const STRIPPED_HEADERS = new Set(['x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-connecting-ip']);

const isLoopback = (address: string): boolean => {
  const ip = address.replace(/^::ffff:/i, '');
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
};

export function forwardingHeaders(
  peerAddress: string,
  incoming: Record<string, string | string[] | undefined>,
  tunnelActive: boolean
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    const key = name.toLowerCase();
    if (value === undefined || STRIPPED_HEADERS.has(key)) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  let client = peerAddress;
  if (tunnelActive && isLoopback(peerAddress)) {
    const cf = [incoming['cf-connecting-ip']]
      .flat()[0]
      ?.split(',')
      .map((s) => s.trim())
      .find((s) => isIP(s) !== 0);
    if (cf) client = cf;
  }
  out['x-forwarded-for'] = client;
  return out;
}
