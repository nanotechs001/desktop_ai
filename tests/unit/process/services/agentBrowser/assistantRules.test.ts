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

const withBlock = (text: string): string => {
  const result = upsertBrowserRule(text);
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
