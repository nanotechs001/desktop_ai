import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpRequest } from '@/common/adapter/httpBridge';
import { BROWSER_RULE_MARKERS, upsertBrowserRule } from '@process/services/agentBrowser/browserRule';
import {
  backendAssistantRuleDeps,
  ensureBrowserRuleForAssistant,
  ensureBrowserRuleInAssistants,
  handleEnsureAgentRule,
} from '@process/services/agentBrowser/assistantRules';

vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));

const httpRequestMock = vi.mocked(httpRequest);

const withBlock = (text: string, name?: string): string => {
  const result = upsertBrowserRule(text, name);
  if (!result.ok) throw new Error('unexpected unbalanced markers');
  return result.content;
};

afterEach(() => {
  vi.restoreAllMocks();
  httpRequestMock.mockReset();
});

describe('ensureBrowserRuleInAssistants', () => {
  it('writes only rules that changed and counts updated/skipped/failed', async () => {
    const rules: Record<string, string> = { 'a:en-US': 'rule A', 'b:en-US': withBlock('rule B'), 'b:zh-CN': '' };
    const writeRule = vi.fn(async (id: string, locale: string, content: string) => {
      rules[`${id}:${locale}`] = content;
    });
    const result = await ensureBrowserRuleInAssistants({
      listAssistants: async () => [
        { id: 'a', locales: ['en-US'] },
        { id: 'b', locales: ['en-US', 'zh-CN'] },
      ],
      readRule: async (id, locale) => rules[`${id}:${locale}`] ?? '',
      writeRule,
    });
    expect(result).toEqual({ updated: 2, skipped: 1, failed: 0 });
    expect(writeRule).toHaveBeenCalledTimes(2);
    expect(rules['a:en-US']).toBe(withBlock('rule A'));
  });

  it('a failing write for one assistant does not stop the others', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeRule = vi.fn(async (id: string) => {
      if (id === 'a') throw new Error('rejected');
    });
    const result = await ensureBrowserRuleInAssistants({
      listAssistants: async () => [
        { id: 'a', locales: ['en-US'] },
        { id: 'b', locales: ['en-US'] },
      ],
      readRule: async () => '',
      writeRule,
    });
    expect(result).toEqual({ updated: 1, skipped: 0, failed: 1 });
    expect(writeRule).toHaveBeenCalledTimes(2);
  });

  it('a failing read for one assistant is counted as failed while the others continue', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeRule = vi.fn(async () => {});
    const result = await ensureBrowserRuleInAssistants({
      listAssistants: async () => [
        { id: 'a', locales: ['en-US'] },
        { id: 'b', locales: ['en-US'] },
      ],
      readRule: async (id) => {
        if (id === 'a') throw new Error('boom');
        return '';
      },
      writeRule,
    });
    expect(result).toEqual({ updated: 1, skipped: 0, failed: 1 });
    expect(writeRule).toHaveBeenCalledTimes(1);
  });

  it('returns zeros, logs and does not throw when listing assistants fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await ensureBrowserRuleInAssistants({
      listAssistants: async () => {
        throw new Error('backend down');
      },
      readRule: async () => '',
      writeRule: async () => {},
    });
    expect(result).toEqual({ updated: 0, skipped: 0, failed: 0 });
    expect(error).toHaveBeenCalled();
  });

  it.each([
    ['an orphan start', `keep A\n${BROWSER_RULE_MARKERS.start}\nuser notes B`],
    ['an orphan end', `keep A\n${BROWSER_RULE_MARKERS.end}\nuser notes B`],
    ['reversed markers', `${BROWSER_RULE_MARKERS.end}\nB\n${BROWSER_RULE_MARKERS.start}`],
  ])('skips an assistant with %s, never writes it, counts it failed and names it in a warning', async (_n, rule) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeRule = vi.fn(async () => {});
    const result = await ensureBrowserRuleInAssistants({
      listAssistants: async () => [{ id: 'broken-one', locales: ['en-US'] }],
      readRule: async () => rule,
      writeRule,
    });
    expect(result).toEqual({ updated: 0, skipped: 0, failed: 1 });
    expect(writeRule).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('broken-one');
  });
});

describe('ensureBrowserRuleInAssistants: names', () => {
  it("names each assistant's block after the name it is listed with", async () => {
    const rules: Record<string, string> = {};
    await ensureBrowserRuleInAssistants({
      listAssistants: async () => [
        { id: 'a', locales: [''], name: 'Ava' },
        { id: 'b', locales: [''] },
      ],
      readRule: async (id) => rules[id] ?? '',
      writeRule: async (id, _locale, content) => {
        rules[id] = content;
      },
    });
    expect(rules.a).toBe(withBlock('', 'Ava'));
    expect(rules.a).toContain("You are Ava, the user's personal assistant.");
    expect(rules.b).toBe(withBlock(''));
  });
});

describe('ensureBrowserRuleForAssistant', () => {
  it('upserts the block into the default rule and the rule of the locale the editor wrote', async () => {
    const rules: Record<string, string> = { ':': '', 'zh-CN:': 'my notes' };
    const writeRule = vi.fn(async (id: string, locale: string, content: string) => {
      rules[`${locale}:`] = content;
      expect(id).toBe('new-agent');
    });
    const result = await ensureBrowserRuleForAssistant(
      { listAssistants: async () => [], readRule: async (_id, locale) => rules[`${locale}:`] ?? '', writeRule },
      'new-agent',
      'zh-CN'
    );
    expect(result).toEqual({ updated: 2, skipped: 0, failed: 0, unbalanced: 0 });
    expect(rules['zh-CN:']).toBe(withBlock('my notes'));
    expect(rules[':']).toBe(withBlock(''));
  });

  it('touches only the one assistant, and only the default rule when no locale is given', async () => {
    const readRule = vi.fn(async () => withBlock('x'));
    const listAssistants = vi.fn(async () => []);
    const result = await ensureBrowserRuleForAssistant({ listAssistants, readRule, writeRule: vi.fn() }, 'solo');
    expect(result).toEqual({ updated: 0, skipped: 1, failed: 0, unbalanced: 0 });
    expect(readRule).toHaveBeenCalledTimes(1);
    expect(readRule).toHaveBeenCalledWith('solo', '');
    expect(listAssistants).not.toHaveBeenCalled();
  });

  it("adds the agent's memory block after the other blocks", async () => {
    let rule = 'my text';
    const readMemory = vi.fn(async () => '# Memory\nKnows the client is Jane.');
    await ensureBrowserRuleForAssistant(
      {
        listAssistants: async () => [],
        readRule: async () => rule,
        writeRule: async (_id, _locale, content) => {
          rule = content;
        },
        readMemory,
      },
      'agent-1'
    );

    expect(readMemory).toHaveBeenCalledWith('agent-1');
    expect(rule).toContain('<!-- aion-memory:start -->\n# Memory\nKnows the client is Jane.\n<!-- aion-memory:end -->');
    expect(rule.indexOf(BROWSER_RULE_MARKERS.start)).toBeLessThan(rule.indexOf('<!-- aion-memory:start -->'));
  });

  it('still updates the rest of the rule when the memory cannot be read', async () => {
    let rule = '';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await ensureBrowserRuleForAssistant(
      {
        listAssistants: async () => [],
        readRule: async () => rule,
        writeRule: async (_id, _locale, content) => {
          rule = content;
        },
        readMemory: async () => {
          throw new Error('disk gone');
        },
      },
      'agent-1'
    );

    expect(result.updated).toBe(1);
    expect(rule).toBe(withBlock(''));
  });
});

describe('handleEnsureAgentRule', () => {
  const deps = (rule = '') => ({
    listAssistants: async () => [],
    readRule: vi.fn(async () => rule),
    writeRule: vi.fn(async () => {}),
  });

  it.each([
    ['no request', undefined],
    ['a non-object request', 'agent'],
    ['a missing id', {}],
    ['an empty id', { assistantId: '' }],
    ['a numeric id', { assistantId: 7 }],
    ['an id over 128 characters', { assistantId: 'a'.repeat(129) }],
    ['a locale that is not a language tag', { assistantId: 'a', locale: '../etc' }],
    ['a locale with an underscore', { assistantId: 'a', locale: 'en_US' }],
    ['a one-letter locale', { assistantId: 'a', locale: 'e' }],
    ['a non-string locale', { assistantId: 'a', locale: 5 }],
  ])('rejects %s without touching any rule', async (_name, request) => {
    const d = deps();
    await expect(handleEnsureAgentRule(request, d)).resolves.toEqual({ success: false, msg: 'Invalid arguments' });
    expect(d.readRule).not.toHaveBeenCalled();
    expect(d.writeRule).not.toHaveBeenCalled();
  });

  it.each(['en', 'en-US', 'zh-CN', 'fil', 'es-419', 'zh-Hant-TW'])('accepts the locale %s', async (locale) => {
    const d = deps();
    await expect(handleEnsureAgentRule({ assistantId: 'a'.repeat(128), locale }, d)).resolves.toEqual({
      success: true,
    });
    expect(d.writeRule).toHaveBeenCalledWith('a'.repeat(128), locale, expect.any(String));
  });

  it('reports unbalanced markers as such, so the UI does not suggest a restart', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps(`mine\n${BROWSER_RULE_MARKERS.start}\nhalf`);
    await expect(handleEnsureAgentRule({ assistantId: 'a' }, d)).resolves.toEqual({
      success: false,
      data: { unbalanced: true },
      msg: 'The AionUi block markers in this Agent are unbalanced',
    });
    expect(d.writeRule).not.toHaveBeenCalled();
  });

  it("a rename updates the bot's block on the next save, keeping the user's text", async () => {
    let name = 'Ava';
    let rule = '';
    const d = {
      listAssistants: async () => [],
      assistantName: vi.fn(async () => name),
      readRule: async () => rule,
      writeRule: vi.fn(async (_id: string, _locale: string, content: string) => {
        rule = content;
      }),
    };
    await handleEnsureAgentRule({ assistantId: 'bare:1', content: 'Be brief.' }, d);
    expect(rule).toBe(withBlock('Be brief.', 'Ava'));

    name = 'Bo'; // the editor saves the new name, then the rule
    await expect(handleEnsureAgentRule({ assistantId: 'bare:1', content: 'Be brief.' }, d)).resolves.toEqual({
      success: true,
    });
    expect(rule).toBe(withBlock('Be brief.', 'Bo'));
    expect(rule).not.toContain('Ava');
    expect(d.assistantName).toHaveBeenLastCalledWith('bare:1');
  });

  it("still saves the user's text when the name lookup fails, with a nameless block", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = { ...deps(), assistantName: vi.fn(async () => Promise.reject(new Error('down'))) };
    await expect(handleEnsureAgentRule({ assistantId: 'a', content: 'Mine.' }, d)).resolves.toEqual({
      success: true,
    });
    expect(d.writeRule).toHaveBeenCalledWith('a', '', withBlock('Mine.'));
  });

  it('reports a backend failure as a plain failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps();
    d.writeRule.mockRejectedValue(new Error('down'));
    await expect(handleEnsureAgentRule({ assistantId: 'a' }, d)).resolves.toEqual({
      success: false,
      msg: 'Could not update the Agent rule',
    });
  });
});

describe('backendAssistantRuleDeps', () => {
  it('lists every non-builtin assistant with only the default locale', async () => {
    httpRequestMock.mockResolvedValueOnce([
      { id: 'bare:1', source: 'generated' },
      { id: 'word-creator', source: 'builtin' },
      { id: 'custom-1', source: 'user' },
    ]);
    await expect(backendAssistantRuleDeps.listAssistants()).resolves.toEqual([
      { id: 'bare:1', locales: [''] },
      { id: 'custom-1', locales: [''] },
    ]);
    expect(httpRequestMock).toHaveBeenCalledWith('GET', '/api/assistants');
  });

  it("carries each assistant's name, and looks one up by id", async () => {
    const list = [
      { id: 'bare:1', source: 'user', name: 'Ava' },
      { id: 'custom-1', source: 'user', name: 'Bo' },
    ];
    httpRequestMock.mockResolvedValue(list);
    await expect(backendAssistantRuleDeps.listAssistants()).resolves.toEqual([
      { id: 'bare:1', locales: [''], name: 'Ava' },
      { id: 'custom-1', locales: [''], name: 'Bo' },
    ]);
    await expect(backendAssistantRuleDeps.assistantName?.('custom-1')).resolves.toBe('Bo');
    await expect(backendAssistantRuleDeps.assistantName?.('gone')).resolves.toBeUndefined();
  });

  it("leaves the default Agent's placeholder name out, so it never introduces itself as Agent", async () => {
    httpRequestMock.mockResolvedValue([
      { id: 'aion-default-agent', source: 'user', name: 'Agent' },
      { id: 'bare:2', source: 'user', name: 'Agent ' },
      { id: 'bare:3', source: 'user', name: ' Agent\u200b' },
    ]);
    await expect(backendAssistantRuleDeps.listAssistants()).resolves.toEqual([
      { id: 'aion-default-agent', locales: [''], name: undefined },
      { id: 'bare:2', locales: [''], name: undefined },
      { id: 'bare:3', locales: [''], name: undefined },
    ]);
    await expect(backendAssistantRuleDeps.assistantName?.('aion-default-agent')).resolves.toBeUndefined();
  });

  it('treats a null assistant list as empty', async () => {
    httpRequestMock.mockResolvedValueOnce(null);
    await expect(backendAssistantRuleDeps.listAssistants()).resolves.toEqual([]);
  });

  it('omits locale from the body when empty and sends it when set', async () => {
    httpRequestMock.mockResolvedValue('text');
    await backendAssistantRuleDeps.readRule('a', '');
    await backendAssistantRuleDeps.readRule('a', 'zh-CN');
    await backendAssistantRuleDeps.writeRule('a', '', 'c');
    await backendAssistantRuleDeps.writeRule('a', 'zh-CN', 'c');
    expect(httpRequestMock.mock.calls).toEqual([
      ['POST', '/api/skills/assistant-rule/read', { assistant_id: 'a' }],
      ['POST', '/api/skills/assistant-rule/read', { assistant_id: 'a', locale: 'zh-CN' }],
      ['POST', '/api/skills/assistant-rule/write', { assistant_id: 'a', content: 'c' }],
      ['POST', '/api/skills/assistant-rule/write', { assistant_id: 'a', content: 'c', locale: 'zh-CN' }],
    ]);
  });

  it('coalesces a null read to an empty string', async () => {
    httpRequestMock.mockResolvedValueOnce(null);
    await expect(backendAssistantRuleDeps.readRule('a', '')).resolves.toBe('');
  });
});
