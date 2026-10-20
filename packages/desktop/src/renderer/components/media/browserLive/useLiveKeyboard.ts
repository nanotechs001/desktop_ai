/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, type RefObject } from 'react';
import type { RefInputType } from '@arco-design/web-react/es/Input/interface';
import type { LiveClientMessage } from './useBrowserLiveStream';

const MAX_TEXT_CHARS = 2000;
/** keydown keyCode while an IME owns the key: its Enter only confirms the composition. */
const IME_KEY_CODE = 229;

/**
 * Sends what the phone keyboard types into the hidden input to the desktop tab: committed text as `text` (a plain key
 * at once, a composition when it ends), Enter and Backspace as `key`. The input is emptied after each send.
 *
 * Native listeners on Arco's inner `<input>`, which run before React's root listener: the input is cleared before
 * Arco's onChange reads it, so Arco's own value stays in step and never fights an IME composition (a controlled
 * `value=''` did, on Gboard and Samsung Keyboard).
 */
export const useLiveKeyboard = (
  inputRef: RefObject<RefInputType | null>,
  send: (message: LiveClientMessage) => void,
  active: boolean
): void => {
  useEffect(() => {
    const input = inputRef.current?.dom;
    if (!active || !input) return;
    let composing = false;
    /** A Backspace keydown already sent this press, so its beforeinput must not send it again. */
    let backspaceSent = false;

    const flush = (): void => {
      const { value } = input;
      input.value = '';
      for (let start = 0; start < value.length; start += MAX_TEXT_CHARS) {
        send({ type: 'text', value: value.slice(start, start + MAX_TEXT_CHARS) });
      }
    };
    const enter = (): void => {
      flush(); // the word being composed goes first
      send({ type: 'key', key: 'Enter' });
    };
    const backspace = (): void => {
      if (composing || input.value) return; // only edits the word being composed
      send({ type: 'key', key: 'Backspace' });
    };

    // React's onBeforeInput carries no inputType; Gboard's Backspace is only visible there (its keydown is Unidentified).
    const onBeforeInput = (event: InputEvent): void => {
      const { inputType } = event;
      if (inputType === 'insertLineBreak' || inputType === 'insertParagraph') {
        event.preventDefault();
        enter();
      } else if (inputType === 'deleteContentBackward') {
        if (backspaceSent) backspaceSent = false;
        else backspace();
      }
    };
    const onInput = (event: Event): void => {
      // Not every browser fires `input` as an InputEvent; `isComposing` is then simply absent.
      if (!composing && !(event as InputEvent).isComposing) flush();
    };
    const onCompositionStart = (): void => {
      composing = true;
    };
    const onCompositionEnd = (): void => {
      composing = false;
      flush();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && event.keyCode !== IME_KEY_CODE) {
        event.preventDefault();
        enter();
      } else if (event.key === 'Backspace' && !composing && !input.value) {
        backspaceSent = true;
        backspace();
      }
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === 'Backspace') backspaceSent = false;
    };

    const controller = new AbortController();
    const { signal } = controller;
    input.addEventListener('beforeinput', onBeforeInput, { signal });
    input.addEventListener('input', onInput, { signal });
    input.addEventListener('compositionstart', onCompositionStart, { signal });
    input.addEventListener('compositionend', onCompositionEnd, { signal });
    input.addEventListener('keydown', onKeyDown, { signal });
    input.addEventListener('keyup', onKeyUp, { signal });
    return () => controller.abort();
  }, [inputRef, send, active]);
};
