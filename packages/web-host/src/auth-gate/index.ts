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

const stripQuery = (rawPath: string): string => rawPath.split(/[?#]/, 1)[0];

/**
 * Case-preserving canonical form: query/fragment stripped, percent-decoded once, `\` as `/`,
 * `//` collapsed, `.`/`..` resolved (never above root). A trailing slash is KEPT, so
 * `/api/agents/` is canonical. Returns null when the path cannot be normalized
 * (bad percent-encoding, not origin-form).
 */
export function normalizePath(rawPath: string): string | null {
  const pathOnly = stripQuery(rawPath);
  if (!pathOnly.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }
  const parts = decoded.replace(/\\/g, '/').split('/');
  const segments: string[] = [];
  for (const segment of parts) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  const last = parts[parts.length - 1];
  const trailingSlash = segments.length > 0 && (last === '' || last === '.' || last === '..');
  return '/' + segments.join('/') + (trailingSlash ? '/' : '');
}

/** True when the raw path (minus query/fragment) is already its own normal form; anything else could be read differently downstream. */
export const isCanonicalPath = (rawPath: string): boolean => stripQuery(rawPath) === normalizePath(rawPath);

const isUnder = (path: string, prefix: string): boolean => path === prefix || path.startsWith(prefix + '/');

export function classifyRequest(method: string, rawPath: string): GateDecision {
  const normalized = normalizePath(rawPath);
  if (normalized === null) return 'blocked';
  const path = normalized.toLowerCase(); // case only matters for comparison
  if (BLOCKED_PREFIXES.some((p) => isUnder(path, p))) return 'blocked';
  if (OPEN_ROUTES.has(`${method.toUpperCase()} ${path}`)) return 'open';
  if (isUnder(path, '/api') || isUnder(path, '/ws')) return 'auth';
  return 'open';
}

type SessionHeaders = { cookie?: string; authorization?: string };

type Verdict = 'valid' | 'invalid' | 'unavailable';

export type SessionValidator = ((headers: SessionHeaders) => Promise<Verdict>) & {
  /** Forget one session (e.g. after logout). */
  invalidate: (headers: SessionHeaders) => void;
  /** Forget all sessions (e.g. after a password change). */
  clear: () => void;
};

export function createSessionValidator(
  fetchUser: (headers: SessionHeaders) => Promise<number>,
  opts: { ttlMs?: number; max?: number; now?: () => number } = {}
): SessionValidator {
  const { ttlMs = GATE_LIMITS.ttlMs, max = GATE_LIMITS.max, now = Date.now } = opts;
  const validUntil = new Map<string, number>(); // insertion order = LRU order
  const inFlight = new Map<string, Promise<Verdict>>();

  const keyOf = (h: SessionHeaders): string =>
    createHash('sha256')
      .update(`${h.cookie ?? ''}\n${h.authorization ?? ''}`)
      .digest('hex');

  const check = async (headers: SessionHeaders): Promise<Verdict> => {
    try {
      const status = await fetchUser(headers);
      if (status >= 200 && status < 300) return 'valid';
      return status === 401 || status === 403 ? 'invalid' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };

  const validate = async (headers: SessionHeaders): Promise<Verdict> => {
    if (!headers.cookie && !headers.authorization) return 'invalid';
    const key = keyOf(headers);

    const expiry = validUntil.get(key);
    if (expiry !== undefined) {
      validUntil.delete(key);
      if (expiry > now()) {
        validUntil.set(key, expiry);
        return 'valid';
      }
    }

    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise: Promise<Verdict> = check(headers).then((verdict) => {
      // Only the current in-flight check may cache: invalidate()/clear() drop it from the map.
      if (inFlight.get(key) === promise) {
        inFlight.delete(key);
        if (verdict === 'valid') {
          validUntil.set(key, now() + ttlMs);
          while (validUntil.size > max) validUntil.delete(validUntil.keys().next().value as string);
        }
      }
      return verdict;
    });
    inFlight.set(key, promise);
    return promise;
  };

  return Object.assign(validate, {
    invalidate: (headers: SessionHeaders) => {
      if (!headers.cookie && !headers.authorization) return;
      const key = keyOf(headers);
      validUntil.delete(key);
      inFlight.delete(key);
    },
    clear: () => {
      validUntil.clear();
      inFlight.clear();
    },
  });
}

const STRIPPED_HEADERS = new Set(['x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'x-client-ip']);
// Connection tokens that are not header names to strip (WebSocket upgrades need these).
const KEPT_CONNECTION_TOKENS = new Set(['upgrade', 'close']);

const isLoopback = (address: string): boolean => {
  const ip = address.replace(/^::ffff:/i, '');
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
};

export function forwardingHeaders(
  peerAddress: string | undefined,
  incoming: Record<string, string | string[] | undefined>,
  tunnelActive: boolean
): Record<string, string> {
  const lowered: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined) lowered[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }

  const connectionTokens = (lowered.connection ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const named = new Set(connectionTokens.filter((t) => !KEPT_CONNECTION_TOKENS.has(t)));

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(lowered)) {
    if (key === 'connection' || key.startsWith('x-forwarded-') || STRIPPED_HEADERS.has(key) || named.has(key)) continue;
    out[key] = value;
  }
  const kept = connectionTokens.filter((t) => KEPT_CONNECTION_TOKENS.has(t));
  if (kept.length > 0) out.connection = kept.map((t) => (t === 'upgrade' ? 'Upgrade' : t)).join(', ');

  const peer = peerAddress || 'unknown';
  let client = peer;
  if (tunnelActive && isLoopback(peer)) {
    const cf = lowered['cf-connecting-ip']
      ?.split(',')
      .map((s) => s.trim())
      .find((s) => isIP(s) !== 0);
    if (cf) client = cf;
  }
  out['x-forwarded-for'] = client;
  return out;
}
