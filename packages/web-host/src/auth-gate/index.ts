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

// Percent-encoded / \ . % ? # NUL: the characters a downstream hop could decode differently.
const RISKY_ENCODING = /%(2f|5c|2e|25|3f|23|00)/i;

/**
 * False when the raw path (minus query/fragment) could be read differently downstream: a `.`/`..`
 * segment, `//`, `\`, a percent-encoded `/ \ . % ? # NUL`, or undecodable. Ordinary encodings
 * (`%20`, `%C3%A9`) and a trailing slash are canonical.
 */
export function isCanonicalPath(rawPath: string): boolean {
  const pathOnly = stripQuery(rawPath);
  if (normalizePath(rawPath) === null) return false;
  if (pathOnly.includes('//') || pathOnly.includes('\\') || RISKY_ENCODING.test(pathOnly)) return false;
  return !pathOnly.split('/').some((segment) => segment === '.' || segment === '..');
}

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

const SESSION_COOKIE = 'aionui-session';
const REFRESH_COOKIE = 'aionui-refresh';

/** Mirrors aioncore's `extract_cookie_value`: the first non-empty value for `name` wins. */
function cookieValue(cookie: string | undefined, name: string): string {
  for (const part of (cookie ?? '').split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0 || trimmed.slice(0, eq).trim() !== name) continue;
    const value = trimmed.slice(eq + 1).trim();
    if (value) return value;
  }
  return '';
}

const sessionCookieValue = (cookie: string | undefined): string => cookieValue(cookie, SESSION_COOKIE);

/**
 * `iat` of a JWT in epoch ms, read from the UNVERIFIED payload (aioncore still verifies the
 * signature). Null when the token cannot be decoded or has no numeric `iat`.
 */
export function tokenIssuedAtMs(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const iat = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat?: unknown } | null)?.iat;
    return typeof iat === 'number' && Number.isFinite(iat) ? iat * 1000 : null;
  } catch {
    return null;
  }
}

// Fail closed: an undecodable token or one without iat counts as issued before any not-before.
const issuedBefore = (token: string, notBefore: number): boolean => (tokenIssuedAtMs(token) ?? -Infinity) < notBefore;

/**
 * True when a credential on this request predates `sessionsNotBefore` (epoch ms; null = off).
 * Checks every credential aioncore might use: the `Bearer` token and the session cookie.
 * A request with no credential is left to the validator.
 */
export function isSessionRevoked(headers: SessionHeaders, sessionsNotBefore: number | null): boolean {
  if (sessionsNotBefore === null) return false;
  const bearer = headers.authorization?.startsWith('Bearer ') ? headers.authorization.slice(7) : '';
  return [bearer, sessionCookieValue(headers.cookie)].some((t) => t !== '' && issuedBefore(t, sessionsNotBefore));
}

/** True when the refresh cookie predates `sessionsNotBefore`, or is missing (the body fallback cannot be checked). */
export function isRefreshRevoked(cookie: string | undefined, sessionsNotBefore: number | null): boolean {
  if (sessionsNotBefore === null) return false;
  const token = cookieValue(cookie, REFRESH_COOKIE);
  return token === '' || issuedBefore(token, sessionsNotBefore);
}

export function isRefreshRequest(method: string, rawPath: string): boolean {
  return method.toUpperCase() === 'POST' && normalizePath(rawPath)?.toLowerCase() === '/api/auth/refresh';
}

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

  // Keyed on what aioncore authenticates by, so neighbouring cookies share one entry and logout drops it.
  const keyOf = (h: SessionHeaders): string =>
    createHash('sha256')
      .update(`${sessionCookieValue(h.cookie)}\n${h.authorization ?? ''}`)
      .digest('hex');
  const hasCredential = (h: SessionHeaders): boolean => sessionCookieValue(h.cookie) !== '' || !!h.authorization;

  const check = async (headers: SessionHeaders): Promise<Verdict> => {
    try {
      const status = await fetchUser(headers);
      if (status >= 200 && status < 300) return 'valid';
      // aioncore answers a garbage cookie or token with 400, a missing or revoked one with 401.
      return status === 400 || status === 401 || status === 403 ? 'invalid' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  };

  const validate = async (headers: SessionHeaders): Promise<Verdict> => {
    if (!hasCredential(headers)) return 'invalid';
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
      if (!hasCredential(headers)) return;
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
