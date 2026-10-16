import { afterEach, describe, expect, it } from 'vitest';
import { ENTER_LABELS } from '@process/resources/builtinMcp/aionBrowser/inPage';
import { isRiskyLabel } from '@process/services/agentBrowser/confirmGate';

type Report = { labels: string[]; framed: boolean; focused: boolean };
// The in-page source is a function expression; run it here against jsdom, with the focused element.
const enterLabels = new Function(`return ${ENTER_LABELS}`)() as (node: null, key: string) => Report;

/** Puts `html` in the body and focuses its first element. */
const focusOn = (html: string): void => {
  document.body.innerHTML = html;
  (document.body.firstElementChild as HTMLElement).focus();
};
const prompts = (key: string): boolean => enterLabels(null, key).labels.some(isRiskyLabel);

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ENTER_LABELS', () => {
  it('a scroll key on a focused risky button reads nothing, while Space and Enter still read it', () => {
    focusOn('<button>Delete account</button>');
    expect(enterLabels(null, 'PageDown').labels).toEqual([]);
    expect(prompts('PageDown')).toBe(false);
    expect(prompts('Space')).toBe(true);
    expect(prompts('Enter')).toBe(true);
  });

  it.each(['ArrowLeft', 'ArrowRight'])('%s on a focused native select reads its options', (key) => {
    focusOn('<select><option>Choose</option><option>Delete selected</option></select>');
    expect(enterLabels(null, key).labels).toContain('Delete selected');
    expect(prompts(key)).toBe(true);
  });
});
