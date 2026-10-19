import { describe, it, expect, vi } from 'vitest';
import { classifyRequest, createSessionValidator, forwardingHeaders, GATE_LIMITS } from './auth-gate.js';

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
    fetchUser.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await validate(creds)).toBe('unavailable');
    expect(fetchUser).toHaveBeenCalledTimes(2);
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
    await validate({ cookie: 'a' });
    await validate({ cookie: 'a', authorization: 'Bearer x' });
    expect(fetchUser).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used entry past max', async () => {
    const fetchUser = vi.fn().mockResolvedValue(200);
    const validate = createSessionValidator(fetchUser, { max: 2 });
    await validate({ cookie: 'a' });
    await validate({ cookie: 'b' });
    await validate({ cookie: 'a' }); // hit: a becomes most recent
    await validate({ cookie: 'c' }); // evicts b
    expect(fetchUser).toHaveBeenCalledTimes(3);
    await validate({ cookie: 'a' });
    expect(fetchUser).toHaveBeenCalledTimes(3);
    await validate({ cookie: 'b' });
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
});
