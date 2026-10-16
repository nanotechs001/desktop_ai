import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpRequest } from '@/common/adapter/httpBridge';
import { BROWSER_RULE_MARKERS, upsertBrowserRule } from '@process/services/agentBrowser/browserRule';
import {
  backendAssistantRuleDeps,
  ensureBrowserRuleForAssistant,
  ensureBrowserRuleInAssistants,
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
    expect(result).toEqual({ updated: 2, skipped: 0, failed: 0 });
    expect(rules['zh-CN:']).toBe(withBlock('my notes'));
    expect(rules[':']).toBe(withBlock(''));
  });

  it('touches only the one assistant, and only the default rule when no locale is given', async () => {
    const readRule = vi.fn(async () => withBlock('x'));
    const listAssistants = vi.fn(async () => []);
    const result = await ensureBrowserRuleForAssistant({ listAssistants, readRule, writeRule: vi.fn() }, 'solo');
    expect(result).toEqual({ updated: 0, skipped: 1, failed: 0 });
    expect(readRule).toHaveBeenCalledTimes(1);
    expect(readRule).toHaveBeenCalledWith('solo', '');
    expect(listAssistants).not.toHaveBeenCalled();
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
