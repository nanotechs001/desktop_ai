/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FOCUSED_TEXT_FIELD } from '@process/services/agentBrowser/relay/browserView/focusedField';

// The script as a frame runs it: an expression over the page's own document.
// eslint-disable-next-line no-new-func
const run = (): unknown => new Function(`return ${FOCUSED_TEXT_FIELD}`)();

const focus = (html: string): void => {
  document.body.innerHTML = html;
  (document.body.firstElementChild as HTMLElement).focus();
};

describe('the focused text field script', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it.each([
    ['a text input', '<input type="text">'],
    ['an email input', '<input type="email">'],
    ['an input with no type', '<input>'],
    ['a textarea', '<textarea></textarea>'],
  ])('is true for %s', (_name, html) => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    focus(html);
    expect(run()).toBe(true);
  });

  it.each([
    ['a button', '<button>Go</button>'],
    ['a checkbox', '<input type="checkbox">'],
    ['a read-only input', '<input readonly>'],
    ['a link', '<a href="#x">x</a>'],
  ])('is false for %s', (_name, html) => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    focus(html);
    expect(run()).toBe(false);
  });

  it('is false in a frame that does not hold the focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    focus('<input>');
    expect(run()).toBe(false);
  });
});
