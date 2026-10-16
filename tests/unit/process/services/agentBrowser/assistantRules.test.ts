import { describe, expect, it, vi } from 'vitest';
import { upsertBrowserRule } from '@/common/config/browserRule';
import { ensureBrowserRuleInAssistants } from '@process/services/agentBrowser/assistantRules';

describe('ensureBrowserRuleInAssistants', () => {
  it('writes only rules that changed and counts updated/skipped/failed', async () => {
    const rules: Record<string, string> = {
      'a:en-US': 'rule A',
      'b:en-US': upsertBrowserRule('rule B'),
      'b:zh-CN': '',
    };
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
    expect(rules['a:en-US']).toBe(upsertBrowserRule('rule A'));
  });

  it('a failing write for one assistant does not stop the others', async () => {
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
});
