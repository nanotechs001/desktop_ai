import { describe, it, expect, vi } from 'vitest';
import {
  cameThroughTunnel,
  classifyRequest,
  createSessionValidator,
  forwardingHeaders,
  GATE_LIMITS,
  hasUnreadableCredentialBytes,
  isCanonicalPath,
  isRefreshRequest,
  isRefreshRevoked,
  isSessionRevoked,
  normalizePath,
  secureSetCookies,
  sessionIssuedAtMs,
  tokenIssuedAtMs,
} from './index.js';

describe('classifyRequest', () => {
  it.each([
    ['GET', '/'],
    ['GET', '/assets/x.js'],
    ['GET', '/qr-login?token=a'],
    ['POST', '/login'],
    ['POST', '/logout'],
    ['POST', '/api/auth/qr-login'],
    ['GET', '/api/auth/status'],
    ['POST', '/api/auth/refresh'],
  ])('%s %s is open', (method, path) => {
    expect(classifyRequest(method, path)).toBe('open');
  });

  it.each([
    ['POST', '/api/webui/reset-password'],
    ['POST', '/api/webui/change-password?x=1'],
    ['GET', '/api/auth/internal/users'],
    ['POST', '//api/webui/reset-password'],
    ['POST', '/API/WebUI/reset-password'],
    ['POST', '/api/x/../webui/reset-password'],
    ['POST', '/api/webui%2Freset-password'],
    ['POST', '/api/webui'],
    ['GET', '/api/%zz'],
    ['GET', '/api/webui/../../api/auth/internal/x'],
  ])('%s %s is blocked', (method, path) => {
    expect(classifyRequest(method, path)).toBe('blocked');
  });

  it.each([
    ['GET', '/api/auth/user'],
    ['GET', '/api/ws-token'],
    ['GET', '/api/agents'],
    ['GET', '/ws'],
    ['GET', '/api/stt/stream'],
    ['GET', '/api/webui/../agents'],
    ['GET', '/../../api/agents'],
    ['GET', '/api/auth/refresh'],
    ['POST', '/api/auth/status'],
  ])('%s %s needs auth', (method, path) => {
    expect(classifyRequest(method, path)).toBe('auth');
  });
});

describe('normalizePath / isCanonicalPath', () => {
  it('preserves case and trailing slash, strips the query', () => {
    expect(normalizePath('/API/Agents/?x=1')).toBe('/API/Agents/');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/api/x/..')).toBe('/api/');
  });

  it('returns null for bad percent-encoding and non-origin-form paths', () => {
    expect(normalizePath('/api/%zz')).toBeNull();
    expect(normalizePath('http://h/api')).toBeNull();
  });

  it.each([
    '/',
    '/assets/App-ABC.js',
    '/api/agents/',
    '/api/agents?x=1',
    '/API/Agents',
    '/api/skills/my%20skill',
    '/api/x/%C3%A9t%C3%A9',
  ])('%s is canonical', (p) => {
    expect(isCanonicalPath(p)).toBe(true);
  });

  it.each([
    '/api/%2e%2e/x',
    '//api/x',
    '/api\\x',
    '/api/x/../y',
    '/api%252fwebui/x',
    '/api%3F/webui/x',
    '/api%00/agents',
    '/api/./x',
    '/api/%zz',
    '/api/a%2Fb',
    '/api%5cwebui',
    '/api/x/%2E',
    '/api/x/..',
    '/api/a%23b',
  ])('%s is not canonical', (p) => {
    expect(isCanonicalPath(p)).toBe(false);
  });
});

describe('createSessionValidator', () => {
  const creds = { cookie: 'aionui-session=abc' };

  it('caches a valid result until the ttl elapses', async () => {
    let t = 1000;
    const fetchUser = vi.fn().mockResolvedValue(200);
    const validate = createSessionValidator(fetchUser, { ttlMs: 100, now: () => t });
    expect(await validate(creds)).toBe('valid');
    expect(await validate(creds)).toBe('valid');
    expect(fetchUser).toHaveBeenCalledTimes(1);
    t += 101;
    expect(await validate(creds)).toBe('valid');
    expect(fetchUser).toHaveBeenCalledTimes(2);
  });

  it('treats 400 as invalid (aioncore answers a garbage cookie or token with 400)', async () => {
    const validate = createSessionValidator(vi.fn().mockResolvedValue(400));
    expect(await validate(creds)).toBe('invalid');
  });

  it('treats 401/403 as invalid and does not cache', async () => {
    const fetchUser = vi.fn().mockResolvedValue(401);
    const validate = createSessionValidator(fetchUser);
    expect(await validate(creds)).toBe('invalid');
    expect(await validate(creds)).toBe('invalid');
    expect(fetchUser).toHaveBeenCalledTimes(2);
    fetchUser.mockResolvedValue(403);
    expect(await validate(creds)).toBe('invalid');
  });

  it('treats other statuses and thrown errors as unavailable', async () => {
    const fetchUser = vi.fn().mockResolvedValue(500);
    const validate = createSessionValidator(fetchUser);
    expect(await validate(creds)).toBe('unavailable');
    fetchUser.mockResolvedValue(429);
    expect(await validate(creds)).toBe('unavailable');
    fetchUser.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await validate(creds)).toBe('unavailable');
    expect(fetchUser).toHaveBeenCalledTimes(3);
  });

  it('treats empty credentials as invalid without fetching', async () => {
    const fetchUser = vi.fn().mockResolvedValue(200);
    const validate = createSessionValidator(fetchUser);
    expect(await validate({})).toBe('invalid');
    expect(await validate({ cookie: '', authorization: '' })).toBe('invalid');
    expect(fetchUser).not.toHaveBeenCalled();
  });

  it('keys the cache on both cookie and authorization', async () => {
    const fetchUser = vi.fn().mockResolvedValue(200);
    const validate = createSessionValidator(fetchUser);
    await validate({ cookie: 'aionui-session=a' });
    await validate({ cookie: 'aionui-session=a', authorization: 'Bearer x' });
    expect(fetchUser).toHaveBeenCalledTimes(2);
  });

  it('keys the cache on the aionui-session value, ignoring neighbouring cookies', async () => {
    const fetchUser = vi.fn().mockResolvedValue(200);
    const validate = createSessionValidator(fetchUser);
    await validate({ cookie: 'aionui-session=a; theme=dark' });
    await validate({ cookie: 'theme=light; aionui-session=a' });
    await validate({ cookie: 'aionui-session=; aionui-session=a' }); // aioncore takes the first non-empty value
    expect(fetchUser).toHaveBeenCalledTimes(1);
    validate.invalidate({ cookie: 'aionui-session=a' });
    await validate({ cookie: 'x=1; aionui-session=a' });
    expect(fetchUser).toHaveBeenCalledTimes(2);
  });

  it('treats a cookie without an aionui-session value (and no authorization) as invalid without fetching', async () => {
    const fetchUser = vi.fn().mockResolvedValue(200);
    const validate = createSessionValidator(fetchUser);
    expect(await validate({ cookie: 'theme=dark' })).toBe('invalid');
    expect(await validate({ cookie: 'aionui-session=' })).toBe('invalid');
    expect(fetchUser).not.toHaveBeenCalled();
  });

  it('evicts the least recently used entry past max', async () => {
    const fetchUser = vi.fn().mockResolvedValue(200);
    const validate = createSessionValidator(fetchUser, { max: 2 });
    await validate({ cookie: 'aionui-session=a' });
    await validate({ cookie: 'aionui-session=b' });
    await validate({ cookie: 'aionui-session=a' }); // hit: a becomes most recent
    await validate({ cookie: 'aionui-session=c' }); // evicts b
    expect(fetchUser).toHaveBeenCalledTimes(3);
    await validate({ cookie: 'aionui-session=a' });
    expect(fetchUser).toHaveBeenCalledTimes(3);
    await validate({ cookie: 'aionui-session=b' });
    expect(fetchUser).toHaveBeenCalledTimes(4);
  });

  it('dedupes concurrent in-flight checks per key', async () => {
    let release: (status: number) => void = () => {};
    const fetchUser = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const validate = createSessionValidator(fetchUser);
    const calls = Array.from({ length: 20 }, () => validate(creds));
    release(200);
    expect(await Promise.all(calls)).toEqual(Array(20).fill('valid'));
    expect(fetchUser).toHaveBeenCalledTimes(1);
  });

  it('does not cache dedup results that are not valid', async () => {
    const fetchUser = vi.fn().mockResolvedValue(401);
    const validate = createSessionValidator(fetchUser);
    await Promise.all([validate(creds), validate(creds)]);
    expect(fetchUser).toHaveBeenCalledTimes(1);
    await validate(creds);
    expect(fetchUser).toHaveBeenCalledTimes(2);
  });

  it('invalidate drops one cached session', async () => {
    const fetchUser = vi.fn().mockResolvedValue(200);
    const validate = createSessionValidator(fetchUser);
    await validate({ cookie: 'aionui-session=a' });
    await validate({ cookie: 'aionui-session=b' });
    validate.invalidate({ cookie: 'aionui-session=a' });
    validate.invalidate({});
    await validate({ cookie: 'aionui-session=a' });
    await validate({ cookie: 'aionui-session=b' });
    expect(fetchUser).toHaveBeenCalledTimes(3);
  });

  it('invalidate during an in-flight check keeps its result out of the cache', async () => {
    let release: (status: number) => void = () => {};
    const fetchUser = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const validate = createSessionValidator(fetchUser);
    const pending = validate(creds);
    validate.invalidate(creds);
    release(200);
    await pending;
    fetchUser.mockResolvedValue(401);
    expect(await validate(creds)).toBe('invalid');
  });

  it('clear drops every cached session', async () => {
    const fetchUser = vi.fn().mockResolvedValue(200);
    const validate = createSessionValidator(fetchUser);
    await validate({ cookie: 'aionui-session=a' });
    await validate({ cookie: 'aionui-session=b' });
    validate.clear();
    await validate({ cookie: 'aionui-session=a' });
    await validate({ cookie: 'aionui-session=b' });
    expect(fetchUser).toHaveBeenCalledTimes(4);
  });

  it('defaults to GATE_LIMITS', () => {
    expect(GATE_LIMITS).toEqual({ ttlMs: 30_000, max: 500, headerMaxBytes: 16_384 });
  });
});

describe('forwardingHeaders', () => {
  it('replaces a spoofed x-forwarded-for with the peer', () => {
    const out = forwardingHeaders('198.51.100.7', { 'x-forwarded-for': '1.2.3.4', host: 'h' }, false);
    expect(out['x-forwarded-for']).toBe('198.51.100.7');
    expect(out.host).toBe('h');
  });

  it('trusts cf-connecting-ip only from a loopback peer with the tunnel active', () => {
    const cf = { 'cf-connecting-ip': '203.0.113.9' };
    expect(forwardingHeaders('::ffff:127.0.0.1', cf, true)['x-forwarded-for']).toBe('203.0.113.9');
    expect(forwardingHeaders('::ffff:127.0.0.1', cf, false)['x-forwarded-for']).toBe('::ffff:127.0.0.1');
    expect(forwardingHeaders('198.51.100.7', cf, true)['x-forwarded-for']).toBe('198.51.100.7');
  });

  it('falls back to the peer when cf-connecting-ip is not an IP', () => {
    const out = forwardingHeaders('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip' }, true);
    expect(out['x-forwarded-for']).toBe('127.0.0.1');
  });

  it('takes the first valid ip from a cf-connecting-ip list', () => {
    expect(forwardingHeaders('::1', { 'cf-connecting-ip': 'junk, 203.0.113.9' }, true)['x-forwarded-for']).toBe(
      '203.0.113.9'
    );
  });

  it('removes x-real-ip, forwarded and cf-connecting-ip, and joins array values', () => {
    const out = forwardingHeaders(
      '127.0.0.1',
      {
        'x-real-ip': '1.1.1.1',
        forwarded: 'for=1.1.1.1',
        'cf-connecting-ip': '203.0.113.9',
        cookie: ['a=1', 'b=2'],
        gone: undefined,
      },
      true
    );
    expect(out).not.toHaveProperty('x-real-ip');
    expect(out).not.toHaveProperty('forwarded');
    expect(out).not.toHaveProperty('cf-connecting-ip');
    expect(out).not.toHaveProperty('gone');
    expect(out.cookie).toBe('a=1, b=2');
  });

  it('strips every x-forwarded-* and other client-ip headers, case-insensitively', () => {
    const out = forwardingHeaders(
      '198.51.100.7',
      {
        'X-Forwarded-Host': 'evil',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-For': '1.1.1.1',
        'True-Client-IP': '1.1.1.1',
        'X-Client-IP': '1.1.1.1',
        'X-Real-IP': '1.1.1.1',
        Host: 'h',
      },
      false
    );
    expect(out).toEqual({ host: 'h', 'x-forwarded-for': '198.51.100.7' });
  });

  it('reads cf-connecting-ip case-insensitively', () => {
    const out = forwardingHeaders('127.0.0.1', { 'CF-Connecting-IP': '203.0.113.9' }, true);
    expect(out['x-forwarded-for']).toBe('203.0.113.9');
  });

  it('strips headers named in Connection and drops those tokens, keeping upgrade', () => {
    const out = forwardingHeaders(
      '198.51.100.7',
      { connection: 'X-Forwarded-For, Upgrade, x-secret', upgrade: 'websocket', 'x-secret': 's', 'x-other': 'o' },
      false
    );
    expect(out).not.toHaveProperty('x-secret');
    expect(out.connection).toBe('Upgrade');
    expect(out.upgrade).toBe('websocket');
    expect(out['x-other']).toBe('o');
    expect(out['x-forwarded-for']).toBe('198.51.100.7');
  });

  it('uses "unknown" for a missing or empty peer, never "undefined"', () => {
    expect(forwardingHeaders(undefined, {}, false)['x-forwarded-for']).toBe('unknown');
    expect(forwardingHeaders('', {}, true)['x-forwarded-for']).toBe('unknown');
  });
});

const jwt = (payload: unknown): string => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

describe('tokenIssuedAtMs', () => {
  it('reads iat (seconds) from the unverified payload as milliseconds', () => {
    expect(tokenIssuedAtMs(jwt({ iat: 1_700_000_000 }))).toBe(1_700_000_000_000);
  });

  it.each([
    ['not a jwt', 'garbage'],
    ['bad base64 payload', 'a.!!!.c'],
    ['payload that is not JSON', `a.${Buffer.from('nope').toString('base64url')}.c`],
    ['payload without iat', jwt({ sub: 'x' })],
    ['non-numeric iat', jwt({ iat: '1700000000' })],
    ['non-finite iat', jwt({ iat: null })],
  ])('returns null for %s', (_name, token) => {
    expect(tokenIssuedAtMs(token)).toBeNull();
  });
});

describe('isSessionRevoked', () => {
  const NOT_BEFORE = 2_000_000; // ms
  const old = jwt({ iat: 1_999 });
  const fresh = jwt({ iat: 2_000 });

  it('never revokes while not-before is null', () => {
    expect(isSessionRevoked({ cookie: `aionui-session=${old}` }, null)).toBe(false);
    expect(isSessionRevoked({ cookie: 'aionui-session=garbage' }, null)).toBe(false);
  });

  it('revokes a cookie issued before not-before and keeps one issued at or after it', () => {
    expect(isSessionRevoked({ cookie: `aionui-session=${old}` }, NOT_BEFORE)).toBe(true);
    expect(isSessionRevoked({ cookie: `aionui-session=${fresh}` }, NOT_BEFORE)).toBe(false);
  });

  it('revokes a Bearer token issued before not-before and keeps a newer one', () => {
    expect(isSessionRevoked({ authorization: `Bearer ${old}` }, NOT_BEFORE)).toBe(true);
    expect(isSessionRevoked({ authorization: `Bearer ${fresh}` }, NOT_BEFORE)).toBe(false);
  });

  it('fails closed on an undecodable or iat-less token', () => {
    expect(isSessionRevoked({ cookie: 'aionui-session=garbage' }, NOT_BEFORE)).toBe(true);
    expect(isSessionRevoked({ authorization: 'Bearer garbage' }, NOT_BEFORE)).toBe(true);
    expect(isSessionRevoked({ cookie: `aionui-session=${jwt({})}` }, NOT_BEFORE)).toBe(true);
  });

  it('checks every credential present, so a stale cookie cannot ride along a fresh Bearer', () => {
    expect(isSessionRevoked({ cookie: `aionui-session=${old}`, authorization: `Bearer ${fresh}` }, NOT_BEFORE)).toBe(
      true
    );
  });

  it('leaves a request with no credential to the validator', () => {
    expect(isSessionRevoked({}, NOT_BEFORE)).toBe(false);
  });
});

describe('isRefreshRevoked / isRefreshRequest', () => {
  const NOT_BEFORE = 2_000_000;

  it('is off while not-before is null', () => {
    expect(isRefreshRevoked(undefined, null)).toBe(false);
  });

  it('revokes an old refresh cookie and keeps a fresh one', () => {
    expect(isRefreshRevoked(`aionui-refresh=${jwt({ iat: 1_999 })}`, NOT_BEFORE)).toBe(true);
    expect(isRefreshRevoked(`a=b; aionui-refresh=${jwt({ iat: 2_000 })}`, NOT_BEFORE)).toBe(false);
  });

  it('fails closed on a missing, malformed or session-cookie-only refresh credential', () => {
    expect(isRefreshRevoked(undefined, NOT_BEFORE)).toBe(true);
    expect(isRefreshRevoked('aionui-refresh=garbage', NOT_BEFORE)).toBe(true);
    expect(isRefreshRevoked(`aionui-session=${jwt({ iat: 3_000 })}`, NOT_BEFORE)).toBe(true);
  });

  it('recognizes only POST /api/auth/refresh, ignoring query and case', () => {
    expect(isRefreshRequest('POST', '/api/auth/refresh')).toBe(true);
    expect(isRefreshRequest('post', '/API/auth/Refresh?x=1')).toBe(true);
    expect(isRefreshRequest('GET', '/api/auth/refresh')).toBe(false);
    expect(isRefreshRequest('POST', '/api/auth/status')).toBe(false);
  });
});

describe('hasUnreadableCredentialBytes', () => {
  it('accepts tab and visible ASCII in cookie and authorization', () => {
    expect(hasUnreadableCredentialBytes({ cookie: 'a=b;\tc=~!', authorization: 'Bearer abc.def' })).toBe(false);
    expect(hasUnreadableCredentialBytes({})).toBe(false);
  });

  it.each([['\xe9'], ['\x7f'], ['\x00'], ['\x80'], ['\u00e9'], ['\n'], ['\r']])(
    'rejects a cookie containing %j',
    (ch) => {
      expect(hasUnreadableCredentialBytes({ cookie: `aionui-refresh=x; y=${ch}` })).toBe(true);
    }
  );

  it('rejects a bad authorization, in a list of values, with any header-name case', () => {
    expect(hasUnreadableCredentialBytes({ authorization: 'Bearer a\xe9' })).toBe(true);
    expect(hasUnreadableCredentialBytes({ Cookie: ['ok=1', 'bad=\xe9'] })).toBe(true);
  });

  it('ignores other headers', () => {
    expect(hasUnreadableCredentialBytes({ 'user-agent': 'caf\xe9' })).toBe(false);
  });
});

describe('sessionIssuedAtMs', () => {
  it('is the minimum iat across the credentials present', () => {
    const headers = { cookie: `aionui-session=${jwt({ iat: 50 })}`, authorization: `Bearer ${jwt({ iat: 20 })}` };
    expect(sessionIssuedAtMs(headers)).toBe(20_000);
  });

  it('is 0 when there is no credential at all (never Infinity)', () => {
    expect(sessionIssuedAtMs({})).toBe(0);
  });

  it('is 0 when a credential cannot be decoded, so any not-before closes it', () => {
    expect(sessionIssuedAtMs({ cookie: `aionui-session=${jwt({ iat: 50 })}`, authorization: 'Bearer junk' })).toBe(0);
    expect(sessionIssuedAtMs({ cookie: 'aionui-session=junk' })).toBe(0);
  });
});

describe('cameThroughTunnel (R17)', () => {
  const cf = { 'cf-connecting-ip': '203.0.113.7' };
  it('is true only for a loopback peer with Cf-Connecting-Ip while the tunnel runs', () => {
    expect(cameThroughTunnel('127.0.0.1', cf, true)).toBe(true);
    expect(cameThroughTunnel('::ffff:127.0.0.1', cf, true)).toBe(true);
  });
  it.each([
    ['a LAN peer', '192.168.1.5', cf, true],
    ['an unknown peer', 'unknown', cf, true],
    ['no Cf-Connecting-Ip', '127.0.0.1', {}, true],
    ['the tunnel off', '127.0.0.1', cf, false],
  ])('is false for %s', (_name, peer, headers, active) => {
    expect(cameThroughTunnel(peer, headers, active)).toBe(false);
  });
});

describe('secureSetCookies (R17)', () => {
  it('appends Secure where it is missing and never doubles it', () => {
    expect(
      secureSetCookies([
        'a=1; Path=/',
        'b=2; Secure; HttpOnly',
        'c=3; HttpOnly; secure',
        'secure=4',
        'd=5; Path=/insecure',
      ])
    ).toEqual([
      'a=1; Path=/; Secure',
      'b=2; Secure; HttpOnly',
      'c=3; HttpOnly; secure',
      'secure=4; Secure',
      'd=5; Path=/insecure; Secure',
    ]);
  });
});
