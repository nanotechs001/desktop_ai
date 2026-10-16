/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Control, bidi-control, line/paragraph separator and whitespace runs, plus every other format character
// except ZWJ and ZWNJ, which emoji sequences and Indic/Persian text need.
const HIDDEN_CHARS = /(?:(?![\u200C\u200D])\p{Cf}|[\p{Cc}\p{Zl}\p{Zp}\s])+/gu;

/**
 * Text that came from a web page (a title, a url, an element label) made safe to hand to the model:
 * hidden and control characters become single spaces, and the result is cut to `max` code points
 * (never inside a surrogate pair). Page text is untrusted data; callers still say so in their tool description.
 */
export const sanitizePageText = (text: string, max: number): string =>
  Array.from(text.replace(HIDDEN_CHARS, ' ').trim()).slice(0, max).join('');
