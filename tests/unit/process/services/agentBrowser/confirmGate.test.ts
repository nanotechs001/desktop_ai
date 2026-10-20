import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MODE_LOOKUP_TIMEOUT_MS,
  PendingConfirms,
  YOLO_CACHE_MS,
  allowKey,
  createYoloLookup,
  isRiskyLabel,
  isYoloMode,
  loadAllowedOrigins,
  webOriginOf,
  type ChatModeDeps,
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

  it("keeps the request's chat, and ignores a second answer from another view", async () => {
    const confirms = new PendingConfirms({ file });
    const onChange = vi.fn();
    confirms.onChange(onChange);
    const answer = confirms.request({ ...ask, conversationId: 'conv-1' });
    const [open] = confirms.list();
    expect(open.conversationId).toBe('conv-1');

    // The chat card answers first; the browser pane's (or the phone's) later Deny changes nothing.
    expect(confirms.reply(open.id, true, false)).toBe(true);
    expect(confirms.reply(open.id, false, false)).toBe(false);
    expect(await answer).toBe(true);
    // Every view got the full list twice: once with the ask, once without it.
    expect(onChange.mock.calls).toEqual([[[open]], [[]]]);
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

  it('never remembers or auto-allows an opaque-origin frame', async () => {
    const confirms = new PendingConfirms({ file });
    const opaque = { ...ask, frameOrigin: null };
    expect(allowKey(opaque)).toBeNull();
    const first = confirms.request(opaque);
    confirms.reply(confirms.list()[0].id, true, true);
    expect(await first).toBe(true);
    expect(loadAllowedOrigins(file).size).toBe(0);
    void confirms.request(opaque);
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
    for (const content of [
      '{"scriptOrigins": "x"}',
      '{"scriptOrigins": [1]}',
      '{"origins": [], "scriptOrigins": [null]}',
    ]) {
      writeFileSync(path.join(dir, 'bad.json'), content);
      expect(loadAllowedOrigins(path.join(dir, 'bad.json'), 'script').size, content).toBe(0);
    }
    expect(loadAllowedOrigins(path.join(dir, 'missing.json')).size).toBe(0);
  });

  it('remembers page scripts apart from risky clicks: allowing one never allows the other', async () => {
    const script = { ...ask, label: 'window.app', kind: 'script' as const };
    const confirms = new PendingConfirms({ file });
    const first = confirms.request(script);
    confirms.reply(confirms.list()[0].id, true, true);
    expect(await first).toBe(true);
    expect(await confirms.request(script)).toBe(true);
    // A risky click on the same site still asks.
    void confirms.request(ask);
    expect(confirms.list().map((r) => r.label)).toEqual(['Place order']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ origins: [], scriptOrigins: ['https://shop.test'] });
    expect([...loadAllowedOrigins(file, 'script')]).toEqual(['https://shop.test']);
    expect(loadAllowedOrigins(file).size).toBe(0);

    // And the reverse: a click allowance on another site never lets a page script through there.
    const clicks = new PendingConfirms({ file: path.join(dir, 'clicks.json') });
    const click = clicks.request(ask);
    clicks.reply(clicks.list()[0].id, true, true);
    await click;
    expect(await clicks.request({ ...ask, label: 'Delete' })).toBe(true);
    void clicks.request(script);
    expect(clicks.list().map((r) => r.kind)).toEqual(['script']);
  });

  it('reads an allow file from before kinds as click allowances only', async () => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ origins: ['https://shop.test'] }));
    const confirms = new PendingConfirms({ file });
    expect(await confirms.request(ask)).toBe(true);
    void confirms.request({ ...ask, kind: 'script' });
    expect(confirms.list()).toHaveLength(1);
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

describe('"Always allow" on one open ask', () => {
  it("also answers the same site's other open asks of that kind, and only those", async () => {
    const confirms = new PendingConfirms({ file });
    const first = confirms.request(ask);
    const sameSite = confirms.request({ ...ask, label: 'Delete page' });
    void confirms.request({ ...ask, origin: 'https://other.test', frameOrigin: 'https://other.test' });
    void confirms.request({ ...ask, kind: 'script' });
    void confirms.request({ ...ask, frameOrigin: 'https://pay.test' });

    confirms.reply(confirms.list()[0].id, true, true);
    expect(await first).toBe(true);
    expect(await sameSite).toBe(true);
    expect(confirms.list().map((r) => [r.origin, r.frameOrigin, r.kind])).toEqual([
      ['https://other.test', 'https://other.test', undefined],
      ['https://shop.test', 'https://shop.test', 'script'],
      ['https://shop.test', 'https://pay.test', undefined],
    ]);
  });

  it('a plain Allow answers that ask alone', async () => {
    const confirms = new PendingConfirms({ file });
    const first = confirms.request(ask);
    void confirms.request({ ...ask, label: 'Delete page' });
    confirms.reply(confirms.list()[0].id, true, false);
    expect(await first).toBe(true);
    expect(confirms.list().map((r) => r.label)).toEqual(['Delete page']);
  });
});

describe('PendingConfirms in a YOLO chat', () => {
  const inChat = { ...ask, conversationId: 'conv-y' };
  const script = { ...inChat, label: '</> document.title = "x"', kind: 'script' as const };
  const info = () => vi.spyOn(console, 'info').mockImplementation(() => undefined);

  it('allows risky clicks and page scripts with no ask, remembers nothing, and logs no label or code', async () => {
    const log = info();
    const isYolo = vi.fn(async () => true);
    const confirms = new PendingConfirms({ file, isYolo });
    const onChange = vi.fn();
    confirms.onChange(onChange);

    expect(await confirms.request(inChat)).toBe(true);
    expect(await confirms.request(script)).toBe(true);
    expect(isYolo).toHaveBeenCalledWith('conv-y');
    expect(onChange).not.toHaveBeenCalled();
    expect(confirms.list()).toEqual([]);
    expect(() => readFileSync(file)).toThrow();

    const lines = log.mock.calls.map((c) => c.join(' '));
    expect(lines).toEqual([
      expect.stringContaining('https://shop.test click auto-allowed (yolo)'),
      expect.stringContaining('https://shop.test script auto-allowed (yolo)'),
    ]);
    expect(lines.join('\n')).not.toMatch(/Place order|document\.title/);
    log.mockRestore();
  });

  it('still asks in Default mode, when the lookup fails, and for an ask with no chat', async () => {
    const confirms = new PendingConfirms({
      file,
      isYolo: async (id) => (id === 'boom' ? Promise.reject(new Error('down')) : false),
    });
    void confirms.request(inChat);
    void confirms.request({ ...inChat, conversationId: 'boom' });
    void confirms.request(ask);
    await vi.waitFor(() => expect(confirms.list()).toHaveLength(3));
  });

  it('still asks "Leave site?" in a YOLO chat: it guards the user\'s own unsaved text', async () => {
    const isYolo = vi.fn(async () => true);
    const confirms = new PendingConfirms({ file, isYolo });
    const leave = confirms.request({ ...inChat, kind: 'leave', frameOrigin: null, label: '' });
    expect(confirms.list().map((r) => r.kind)).toEqual(['leave']);
    expect(isYolo).not.toHaveBeenCalled();
    confirms.reply(confirms.list()[0].id, false, false);
    expect(await leave).toBe(false);
  });

  it('denies when the action was called off during the lookup', async () => {
    const controller = new AbortController();
    const confirms = new PendingConfirms({
      file,
      isYolo: async () => {
        controller.abort();
        return true;
      },
    });
    expect(await confirms.request(inChat, undefined, controller.signal)).toBe(false);
    expect(confirms.list()).toEqual([]);
  });
});

describe('isYoloMode', () => {
  const claude = { id: '2d23ff1c', backend: 'claude', yolo_id: 'bypassPermissions' };
  const codex = { id: '8e1acf31', backend: 'codex', yolo_id: 'agent-full-access' };
  const opencode = { id: '53861a53', backend: 'opencode', yolo_id: 'build' };
  const hermes = { id: '55f3ed1c', backend: 'hermes' };

  it.each([
    ['bypassPermissions', 'acp', claude, true],
    ['default', 'acp', claude, false],
    ['acceptEdits', 'acp', claude, false],
    ['plan', 'acp', claude, false],
    ['agent-full-access', 'acp', codex, true],
    ['full-access', 'acp', codex, true],
    ['auto', 'acp', codex, false],
    ['build', 'acp', opencode, true],
    ['plan', 'acp', opencode, false],
    ['yolo', 'acp', claude, true],
    ['yoloNoSandbox', 'acp', codex, true],
    ['yolo', 'acp', hermes, false],
    ['default', 'acp', hermes, false],
    ['yolo', 'aionrs', undefined, true],
    ['auto_edit', 'aionrs', undefined, false],
    ['default', 'aionrs', undefined, false],
    ['bypassPermissions', 'acp', undefined, false],
  ] as const)('%s on %s (%o) is YOLO: %s', (mode, type, agent, yolo) => {
    expect(isYoloMode(mode, { type, agent })).toBe(yolo);
  });

  it('is never YOLO without a mode', () => {
    expect(isYoloMode(null, { type: 'aionrs' })).toBe(false);
    expect(isYoloMode('', { type: 'acp', agent: claude })).toBe(false);
  });
});

describe('createYoloLookup', () => {
  const modeOption = (value: string | null) => ({
    id: 'mode',
    category: 'mode',
    option_type: 'select' as const,
    current_value: value,
    options: [],
  });
  const deps = (mode: { value: string | null }): ChatModeDeps & Record<string, ReturnType<typeof vi.fn>> => ({
    configOptions: vi.fn(async () => [{ id: 'model', category: 'model', options: [] }, modeOption(mode.value)]),
    conversation: vi.fn(async () => ({ type: 'acp', extra: { agent_id: '2d23ff1c', backend: 'claude' } })),
    agents: vi.fn(async () => [
      { id: '8e1acf31', backend: 'codex', yolo_id: 'agent-full-access' },
      { id: '2d23ff1c', backend: 'claude', yolo_id: 'bypassPermissions' },
    ]),
  });

  it("reads the chat's live mode against its own agent's YOLO id", async () => {
    const mode = { value: 'bypassPermissions' };
    const d = deps(mode);
    expect(await createYoloLookup(d)('conv-1')).toBe(true);
    expect(d.configOptions).toHaveBeenCalledWith('conv-1');
    expect(d.conversation).toHaveBeenCalledWith('conv-1');
    mode.value = 'agent-full-access'; // codex's YOLO id, not this claude chat's
    expect(await createYoloLookup(d)('conv-1')).toBe(false);
  });

  it("finds a chat's agent by its backend when the chat names no agent id and only one agent has that backend", async () => {
    const d = deps({ value: 'bypassPermissions' });
    d.conversation.mockResolvedValue({ type: 'acp', extra: { backend: 'claude' } });
    expect(await createYoloLookup(d)('conv-1')).toBe(true);
    d.agents.mockResolvedValue([
      { id: 'a', backend: 'claude', yolo_id: 'bypassPermissions' },
      { id: 'b', backend: 'claude', yolo_id: 'bypassPermissions' },
    ]);
    expect(await createYoloLookup(d)('conv-2')).toBe(false);
  });

  it('keeps an answer for 2 s, then looks again: switching back to Default asks again', async () => {
    let now = 1000;
    const mode = { value: 'bypassPermissions' };
    const d = deps(mode);
    const isYolo = createYoloLookup(d, { now: () => now });
    expect(await isYolo('conv-1')).toBe(true);
    mode.value = 'default';
    now += YOLO_CACHE_MS - 1;
    expect(await isYolo('conv-1')).toBe(true);
    expect(d.configOptions).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await isYolo('conv-1')).toBe(false);
    expect(d.configOptions).toHaveBeenCalledTimes(2);
    // Each chat has its own entry.
    expect(await isYolo('conv-2')).toBe(false);
    expect(d.configOptions).toHaveBeenCalledTimes(3);
  });

  it('answers not YOLO when any lookup fails, a chat is gone, or it has no mode, and caches no failure', async () => {
    const error = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = deps({ value: 'bypassPermissions' });
    d.configOptions.mockRejectedValueOnce(new Error('runtime restarting'));
    const isYolo = createYoloLookup(d);
    expect(await isYolo('conv-1')).toBe(false);
    expect(await isYolo('conv-1')).toBe(true);

    d.agents.mockRejectedValueOnce(new Error('down'));
    expect(await createYoloLookup(d)('conv-1')).toBe(false);
    d.conversation.mockResolvedValueOnce(null);
    expect(await createYoloLookup(d)('conv-1')).toBe(false);
    d.configOptions.mockResolvedValueOnce([{ id: 'model', category: 'model', options: [] }]);
    expect(await createYoloLookup(d)('conv-1')).toBe(false);
    error.mockRestore();
  });

  it('answers not YOLO when the backend does not answer in time', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = deps({ value: 'bypassPermissions' });
    d.configOptions.mockReturnValueOnce(new Promise(() => undefined));
    const answer = createYoloLookup(d)('conv-1');
    await vi.advanceTimersByTimeAsync(MODE_LOOKUP_TIMEOUT_MS);
    expect(await answer).toBe(false);
    error.mockRestore();
  });
});
