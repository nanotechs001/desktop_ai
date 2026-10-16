import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PendingConfirms,
  allowKey,
  isRiskyLabel,
  loadAllowedOrigins,
  webOriginOf,
} from '@process/services/agentBrowser/confirmGate';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'confirm-gate-'));
  file = path.join(dir, '.aionui', 'browser-allow.json');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const ask = {
  origin: 'https://shop.test',
  frameOrigin: 'https://shop.test',
  label: 'Place order',
  clientLabel: 'aion-browser-x',
};

describe('isRiskyLabel', () => {
  it.each(['Publish', 'Send message', 'Place order', 'Delete page', 'Submit', 'PAY now', 'Check-out: checkout'])(
    '%s is risky',
    (label) => {
      expect(isRiskyLabel(label)).toBe(true);
    }
  );

  it.each(['Published posts', 'Sender', 'Preview', 'Save draft', 'Payment history', '', 'Reposted'])(
    '%s is not risky',
    (label) => {
      expect(isRiskyLabel(label)).toBe(false);
    }
  );
});

describe('webOriginOf', () => {
  it('gives the origin of web pages and null for anything else', () => {
    expect(webOriginOf('https://a.test:8443/x?y#z')).toBe('https://a.test:8443');
    expect(webOriginOf('http://a.test/')).toBe('http://a.test');
    for (const url of ['about:blank', 'data:text/html,hi', 'file:///tmp/a.html', 'not a url', '']) {
      expect(webOriginOf(url), url).toBeNull();
    }
  });
});

describe('PendingConfirms', () => {
  it('blocks until Allow, listing the request for the pane meanwhile', async () => {
    const confirms = new PendingConfirms({ file });
    const onChange = vi.fn();
    confirms.onChange(onChange);
    let settled: boolean | undefined;
    const answer = confirms.request(ask).then((allow) => (settled = allow));
    await Promise.resolve();

    const [open] = confirms.list();
    expect(open).toMatchObject(ask);
    expect(settled).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith([open]);

    expect(confirms.reply(open.id, true, false)).toBe(true);
    expect(await answer).toBe(true);
    expect(confirms.list()).toEqual([]);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('Deny resolves false; an unknown or answered id is refused', async () => {
    const confirms = new PendingConfirms({ file });
    const answer = confirms.request(ask);
    const [open] = confirms.list();
    expect(confirms.reply(open.id, false, true)).toBe(true);
    expect(await answer).toBe(false);
    expect(confirms.reply(open.id, true, false)).toBe(false);
    expect(confirms.reply('nope', true, false)).toBe(false);
    // A denial never remembers the site, even when asked to.
    expect(loadAllowedOrigins(file).size).toBe(0);
  });

  it('Always allow on this site skips later prompts for that origin only, and is written atomically', async () => {
    const confirms = new PendingConfirms({ file });
    const first = confirms.request(ask);
    confirms.reply(confirms.list()[0].id, true, true);
    expect(await first).toBe(true);

    expect(await confirms.request({ ...ask, label: 'Delete page' })).toBe(true);
    expect(confirms.list()).toEqual([]);

    void confirms.request({ ...ask, origin: 'https://other.test' });
    expect(confirms.list().map((r) => r.origin)).toEqual(['https://other.test']);

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ origins: ['https://shop.test'] });
    expect(readdirSync(path.dirname(file))).toEqual(['browser-allow.json']);
    // A new instance reads the saved allowance.
    expect(await new PendingConfirms({ file }).request(ask)).toBe(true);
  });

  it('keys the allowance on the frame too: a top-origin allowance never covers a cross-origin frame', async () => {
    const confirms = new PendingConfirms({ file });
    const first = confirms.request(ask);
    confirms.reply(confirms.list()[0].id, true, true);
    await first;

    const inFrame = { ...ask, frameOrigin: 'https://pay.test' };
    void confirms.request(inFrame);
    expect(confirms.list().map((r) => r.frameOrigin)).toEqual(['https://pay.test']);
    confirms.reply(confirms.list()[0].id, true, true);

    expect(allowKey(inFrame)).toBe('https://shop.test|https://pay.test');
    expect(JSON.parse(readFileSync(file, 'utf8')).origins).toEqual([
      'https://shop.test',
      'https://shop.test|https://pay.test',
    ]);
    expect(await confirms.request(inFrame)).toBe(true);
    // The frame's own origin at the top is a different page again.
    void confirms.request({ ...ask, origin: 'https://pay.test', frameOrigin: 'https://pay.test' });
    expect(confirms.list()).toHaveLength(1);
  });

  it('reads the allow file again when it changes, and ignores one over 64 KB', async () => {
    const confirms = new PendingConfirms({ file });
    void confirms.request(ask);
    confirms.reply(confirms.list()[0].id, false, false);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ origins: ['https://shop.test'] }));
    expect(await confirms.request(ask)).toBe(true);

    writeFileSync(file, JSON.stringify({ origins: ['https://shop.test'], pad: 'x'.repeat(70_000) }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    void confirms.request(ask);
    expect(confirms.list()).toHaveLength(1);
  });

  it('keeps at most 500 allowed entries, the newest', () => {
    mkdirSync(path.dirname(file), { recursive: true });
    const many = Array.from({ length: 600 }, (_, i) => `https://s${i}.test`);
    writeFileSync(file, JSON.stringify({ origins: many }));
    expect([...loadAllowedOrigins(file)]).toEqual(many.slice(0, 500));
  });

  it('an unanswered confirm denies after 120 s', async () => {
    vi.useFakeTimers();
    const confirms = new PendingConfirms({ file });
    const answer = confirms.request(ask);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(confirms.list()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await answer).toBe(false);
    expect(confirms.list()).toEqual([]);
  });

  it('denies and withdraws the prompt when its signal aborts, or when it is already aborted', async () => {
    const confirms = new PendingConfirms({ file });
    const controller = new AbortController();
    const answer = confirms.request(ask, undefined, controller.signal);
    expect(confirms.list()).toHaveLength(1);
    controller.abort();
    expect(await answer).toBe(false);
    expect(confirms.list()).toEqual([]);
    expect(await confirms.request(ask, undefined, AbortSignal.abort())).toBe(false);
    expect(confirms.list()).toEqual([]);
  });

  it('reads a corrupt or malformed allow file as empty and never throws', () => {
    for (const content of ['{not json', '[]', '{"origins": "x"}', '{"origins": [1, null]}']) {
      writeFileSync(path.join(dir, 'bad.json'), content);
      expect(loadAllowedOrigins(path.join(dir, 'bad.json')).size, content).toBe(0);
    }
    expect(loadAllowedOrigins(path.join(dir, 'missing.json')).size).toBe(0);
  });

  it('keeps the allowance for this run when the file cannot be written', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeFileSync(path.join(dir, 'blocker'), 'a file where a directory should be');
    const confirms = new PendingConfirms({ file: path.join(dir, 'blocker', 'browser-allow.json') });
    const first = confirms.request(ask);
    confirms.reply(confirms.list()[0].id, true, true);
    await first;
    expect(await confirms.request(ask)).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
