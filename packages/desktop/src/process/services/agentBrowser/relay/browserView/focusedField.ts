/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A frame of the tab that runs a script (Electron's WebFrameMain). */
export type ScriptFrame = { executeJavaScript(code: string): Promise<unknown> };

/**
 * True in the frame that holds the focus when its focused element takes typed text. A frame whose focus is in a
 * child frame sees the iframe element here, so only the innermost frame answers true. The cast turns focus
 * emulation on, so a tab in the background still reports its focus.
 */
export const FOCUSED_TEXT_FIELD = `(() => {
  if (!document.hasFocus()) return false;
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.disabled || el.readOnly) return false;
  if (el.tagName === 'TEXTAREA') return true;
  const nonText = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'];
  return el.tagName === 'INPUT' && !nonText.includes(el.type);
})()`;

/** Whether a text field of the tab has the focus, in any of its frames. A frame that cannot answer counts as no. */
export async function textFieldFocused(frames: readonly ScriptFrame[]): Promise<boolean> {
  const answers = await Promise.all(
    frames.map((frame) => frame.executeJavaScript(FOCUSED_TEXT_FIELD).catch(() => false))
  );
  return answers.some((answer) => answer === true);
}
