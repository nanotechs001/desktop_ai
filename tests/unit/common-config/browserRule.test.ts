import { describe, expect, it } from 'vitest';
import { BROWSER_RULE_MARKERS, BROWSER_RULE_TEXT, upsertBrowserRule } from '@/common/config/browserRule';

const { start, end } = BROWSER_RULE_MARKERS;
const block = `${start}\n${BROWSER_RULE_TEXT}\n${end}`;

const upsertContent = (text: string): string => {
  const result = upsertBrowserRule(text);
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.content;
};

describe('upsertBrowserRule', () => {
  it('appends the marked block to a rule without one', () => {
    expect(upsertContent('Be nice.')).toBe(`Be nice.\n\n${block}\n`);
  });

  it('keeps user text byte-for-byte and adds only the separator newlines needed', () => {
    expect(upsertContent('Be nice.\n')).toBe(`Be nice.\n\n${block}\n`);
    expect(upsertContent('Be nice.\n\n')).toBe(`Be nice.\n\n${block}\n`);
    expect(upsertContent('Be nice.  \n\n\n')).toBe(`Be nice.  \n\n\n${block}\n`);
  });

  it('replaces only the marked block in place and keeps user text before and after it', () => {
    const stale = `before\n\n${start}\nold text\n${end}\n\nafter`;
    expect(upsertContent(stale)).toBe(`before\n\n${block}\n\nafter`);
  });

  it('is idempotent: upsert(upsert(x)) === upsert(x) and returns the same string when already current', () => {
    const once = upsertContent('Be nice.');
    expect(upsertContent(once)).toBe(once);
    const edited = `before\n${start}\nold\n${end}\nafter`;
    const twice = upsertContent(upsertContent(edited));
    expect(twice).toBe(upsertContent(edited));
  });

  it('handles an empty rule', () => {
    expect(upsertContent('')).toBe(`${block}\n`);
  });

  it.each([
    ['an orphan start', `keep A\n${start}\nuser notes B\nuser notes C`],
    ['an orphan end', `keep A\n${end}\nuser notes B`],
    ['a reversed end-then-start', `keep A\n${end}\nuser notes B\n${start}\nuser notes C`],
    ['two blocks', `${block}\nmiddle\n${block}`],
  ])('rejects %s without producing content', (_name, text) => {
    expect(upsertBrowserRule(text)).toEqual({ ok: false, reason: 'unbalanced-markers' });
  });
});

describe('BROWSER_RULE_TEXT', () => {
  it('is under 1200 chars and contains each required word as a whole word', () => {
    expect(BROWSER_RULE_TEXT.length).toBeLessThan(1200);
    for (const word of ['aionui-browser', 'open', 'xdg-open', 'osascript', 'webbrowser', 'untrusted', 'MCP']) {
      const escaped = word.replace(/[-]/g, '\\-');
      expect(BROWSER_RULE_TEXT, word).toMatch(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`));
    }
  });

  it('names the browser tools and the tabs -> observe -> act workflow', () => {
    for (const word of ['tabs', 'observe', 'act', 'drag']) {
      expect(BROWSER_RULE_TEXT).toMatch(new RegExp(`\\b${word}\\b`));
    }
    expect(BROWSER_RULE_TEXT).toContain('`tabs` (action `open`)');
  });

  it('tells the model to report missing browser tools instead of opening another browser', () => {
    expect(BROWSER_RULE_TEXT).toContain('tell the user instead of opening any other browser');
  });
});
