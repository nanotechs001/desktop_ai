import { describe, expect, it } from 'vitest';
import { BROWSER_RULE_MARKERS, upsertBrowserRule } from '@process/services/agentBrowser/browserRule';
import { DEFAULT_AGENT_ID, isUndeletableAgent } from '@/common/types/agent/defaultAgent';
import { stripBrowserRule } from '@/common/types/agent/managedRuleBlock';

const withBlock = (text: string): string => {
  const result = upsertBrowserRule(text);
  if (!result.ok) throw new Error('unbalanced');
  return result.content;
};
const NOTES = '<!-- aion-notes:start -->\nremember: be kind\n<!-- aion-notes:end -->';

describe('stripBrowserRule', () => {
  it('leaves text without managed blocks untouched', () => {
    expect(stripBrowserRule('Be brief.\n')).toBe('Be brief.\n');
    expect(stripBrowserRule('')).toBe('');
  });

  it('removes the browser block and returns only the user text', () => {
    expect(stripBrowserRule(withBlock('Be brief.'))).toBe('Be brief.');
  });

  it('returns an empty string when the rule holds nothing but the block', () => {
    expect(stripBrowserRule(withBlock(''))).toBe('');
  });

  it('round-trips: stripping then upserting gives back the stored rule', () => {
    const stored = withBlock('Line one.\n\nLine two.');
    expect(withBlock(stripBrowserRule(stored))).toBe(stored);
  });

  it('removes any aion-* managed block, several at once, and keeps text around them', () => {
    const stored = `Intro.\n\n${NOTES}\n\nMiddle.\n\n${withBlock('').trim()}\n\nOutro.`;
    expect(stripBrowserRule(stored)).toBe('Intro.\n\nMiddle.\n\nOutro.');
  });

  it.each([
    ['an orphan start', `keep\n${BROWSER_RULE_MARKERS.start}\nnotes`],
    ['an orphan end', `keep\n${BROWSER_RULE_MARKERS.end}\nnotes`],
    ['reversed markers', `${BROWSER_RULE_MARKERS.end}\nx\n${BROWSER_RULE_MARKERS.start}`],
    ['a duplicated block', `${withBlock('a')}\n${withBlock('b')}`],
    ['a broken notes block next to a good browser block', `${withBlock('a')}\n<!-- aion-notes:start -->\nx`],
  ])('leaves %s visible instead of stripping', (_name, text) => {
    expect(stripBrowserRule(text)).toBe(text);
  });
});

describe('isUndeletableAgent', () => {
  it('protects the fixed default id even when no stored id has reached the cache', () => {
    expect(isUndeletableAgent(DEFAULT_AGENT_ID, undefined)).toBe(true);
  });

  it('protects an adopted default by its stored id, and nothing else', () => {
    expect(isUndeletableAgent('adopted', 'adopted')).toBe(true);
    expect(isUndeletableAgent('other', 'adopted')).toBe(false);
    expect(isUndeletableAgent('other', undefined)).toBe(false);
  });
});
