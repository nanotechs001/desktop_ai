import { describe, expect, it } from 'vitest';
import {
  BROWSER_RULE_MARKERS,
  BROWSER_RULE_MAX_CHARS,
  BROWSER_RULE_TEXT,
  upsertBrowserRule,
} from '@process/services/agentBrowser/browserRule';

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
  it('fits the rule-block cap and contains each required word as a whole word', () => {
    expect(BROWSER_RULE_TEXT.length).toBeLessThanOrEqual(BROWSER_RULE_MAX_CHARS);
    for (const word of ['aionui-browser', 'open', 'xdg-open', 'osascript', 'webbrowser', 'untrusted', 'MCP']) {
      const escaped = word.replace(/[-]/g, '\\-');
      expect(BROWSER_RULE_TEXT, word).toMatch(new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`));
    }
  });

  it('tells the agent to show pages with the artifacts tool, not a file, and stays within the cap', () => {
    expect(BROWSER_RULE_TEXT).toContain(
      'To show the user a page, document or diagram you made, use `artifacts` (the `create` tool of `aionui-artifacts`), not a file.'
    );
    expect(BROWSER_RULE_TEXT.length).toBeLessThanOrEqual(BROWSER_RULE_MAX_CHARS);
  });

  it('says the agent browses in its own profile and asks the user to sign in or import cookies', () => {
    expect(BROWSER_RULE_TEXT).toContain(
      "- You browse in this Agent's own browser profile, apart from the user's. When a site needs a sign-in, ask the user to sign in in the pane or to import cookies."
    );
    expect(BROWSER_RULE_TEXT).not.toMatch(/shared across tabs/i);
    expect(BROWSER_RULE_TEXT.length).toBeLessThanOrEqual(BROWSER_RULE_MAX_CHARS);
  });

  it('has a Skills and lessons section naming the real tool ids, within the cap', () => {
    expect(BROWSER_RULE_TEXT).toContain('# Skills and lessons');
    expect(BROWSER_RULE_TEXT).toContain(
      '- Before you start a task, check your skills; if one matches the work, follow it.'
    );
    expect(BROWSER_RULE_TEXT).toContain('`mcp__aionui-notes__add`');
    expect(BROWSER_RULE_TEXT).toContain('`mcp__aionui-notes__propose_skill`');
    expect(BROWSER_RULE_TEXT).toContain(
      'Before your final reply on any task where you used tools or the user corrected you, save one or two short lessons'
    );
    expect(BROWSER_RULE_TEXT).toContain('Never say a skill is saved');
    expect(BROWSER_RULE_TEXT).not.toContain('Skip it when you learned nothing new');
    expect(BROWSER_RULE_TEXT).not.toContain('# Lessons');
    // The notes block brings its own "# Notebook" heading; the rule must not repeat it.
    expect(BROWSER_RULE_TEXT).not.toContain('# Notebook');
    expect(BROWSER_RULE_TEXT.length).toBeLessThanOrEqual(BROWSER_RULE_MAX_CHARS);
    expect(BROWSER_RULE_MAX_CHARS).toBe(2000);
  });

  it('tells the agent to refer to itself as the agent', () => {
    expect(BROWSER_RULE_TEXT).toContain(
      "You are the Pixebot Browser agent. Refer to yourself as 'the agent'; do not name your vendor, product or model unless the user asks which model is in use."
    );
  });

  it('starts with tabs and only promises tools that are listed', () => {
    expect(BROWSER_RULE_TEXT).toContain('Start with `tabs`: `open` gets you a tab, `list` shows tabs you can use.');
    expect(BROWSER_RULE_TEXT).toContain('Do not assume a tool exists unless it is listed.');
    expect(BROWSER_RULE_TEXT).not.toMatch(/`(observe|act|drag)`/);
  });

  it('tells the model to report missing browser tools instead of opening another browser', () => {
    expect(BROWSER_RULE_TEXT).toContain('tell the user instead of opening any other browser');
  });
});
