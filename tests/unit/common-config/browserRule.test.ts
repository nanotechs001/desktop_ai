import { describe, expect, it } from 'vitest';
import { BROWSER_RULE_MARKERS, BROWSER_RULE_TEXT, upsertBrowserRule } from '@/common/config/browserRule';

const block = `${BROWSER_RULE_MARKERS.start}\n${BROWSER_RULE_TEXT}\n${BROWSER_RULE_MARKERS.end}`;

describe('upsertBrowserRule', () => {
  it('appends the marked block to a rule without one', () => {
    expect(upsertBrowserRule('Be nice.')).toBe(`Be nice.\n\n${block}\n`);
  });

  it('replaces only the marked block and keeps user text before and after it', () => {
    const stale = `before\n\n${BROWSER_RULE_MARKERS.start}\nold text\n${BROWSER_RULE_MARKERS.end}\n\nafter`;
    expect(upsertBrowserRule(stale)).toBe(`before\n\n${block}\n\nafter`);
  });

  it('is idempotent: upsert(upsert(x)) === upsert(x) and returns the same string when already current', () => {
    const once = upsertBrowserRule('Be nice.');
    expect(upsertBrowserRule(once)).toBe(once);
  });

  it('handles an empty rule', () => {
    expect(upsertBrowserRule('')).toBe(`${block}\n`);
  });
});

describe('BROWSER_RULE_TEXT', () => {
  it('is under 1200 chars and mentions aionui-browser, open, osascript and webbrowser', () => {
    expect(BROWSER_RULE_TEXT.length).toBeLessThan(1200);
    for (const word of ['aionui-browser', 'open', 'osascript', 'webbrowser', 'tabs', 'observe', 'act', 'untrusted']) {
      expect(BROWSER_RULE_TEXT).toContain(word);
    }
  });
});
