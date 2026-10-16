/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Control, format (zero-width, bidi override, BOM) and line/paragraph separator characters, and any whitespace run.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu;

/**
 * Text that came from a web page (a title, a url, an element label) made safe to hand to the model:
 * control and invisible characters become single spaces, and the result is cut to `max` characters.
 * Page text is untrusted data; callers still say so in their tool description.
 */
export const sanitizePageText = (text: string, max: number): string =>
  text.replace(HIDDEN_CHARS, ' ').trim().slice(0, max);
