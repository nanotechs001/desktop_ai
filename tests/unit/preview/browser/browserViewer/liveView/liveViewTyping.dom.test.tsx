/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Typing on the phone into the desktop tab: the hidden input sends what the keyboard commits (plain keys at once, an
 * IME composition once it ends) and Enter/Backspace as keys. Phone keyboards (Gboard, Samsung) compose most words.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', async () => {
  const { preview } = await import('./liveViewHarness');
  return { useOptionalPreviewContext: () => preview.value };
});

import WebviewHost from '@/renderer/components/media/WebviewHost';
import {
  type FakeWebSocket,
  layOutView,
  openSocket,
  setUpLiveView,
  showFrame,
  tearDownLiveView,
} from './liveViewHarness';

beforeEach(setUpLiveView);

afterEach(() => {
  cleanup();
  tearDownLiveView();
});

const connected = async (): Promise<FakeWebSocket> => {
  render(<WebviewHost url='https://one.example/' liveView />);
  return openSocket();
};

const hiddenInput = (): HTMLInputElement => screen.getByRole('textbox');

type InputFields = { inputType?: string; data?: string | null; isComposing?: boolean };

const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

/**
 * Dispatches what a browser fires on the input, after the keyboard put `value` in it. The value goes through the
 * prototype setter, as a keyboard's would, so React and Arco see the change too and take part as they do for real.
 */
const fire = (input: HTMLInputElement, type: string, fields: InputFields, value?: string): void => {
  if (value !== undefined) setNativeValue?.call(input, value);
  act(() => {
    input.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), fields));
  });
};

const typeKey = (input: HTMLInputElement, char: string): void => {
  fire(input, 'beforeinput', { inputType: 'insertText', data: char });
  fire(input, 'input', { inputType: 'insertText', data: char, isComposing: false }, input.value + char);
};

/** Gboard-style: the word grows inside one composition. */
const compose = (input: HTMLInputElement, word: string): void => {
  fire(input, 'compositionstart', { data: '' });
  for (let end = 1; end <= word.length; end++) {
    const part = word.slice(0, end);
    fire(input, 'input', { inputType: 'insertCompositionText', data: part, isComposing: true }, part);
  }
};

const sentInput = (ws: FakeWebSocket) => ws.messages().filter((m) => m.type === 'text' || m.type === 'key');

describe('BrowserLiveView typing', () => {
  it('plain input events send text, and the input is emptied after each', async () => {
    const ws = await connected();
    const input = hiddenInput();

    typeKey(input, 'h');
    typeKey(input, 'i');

    expect(sentInput(ws)).toEqual([
      { type: 'text', value: 'h' },
      { type: 'text', value: 'i' },
    ]);
    expect(input.value).toBe('');
  });

  it('a pasted run of text is sent as one text message', async () => {
    const ws = await connected();
    const input = hiddenInput();

    fire(input, 'input', { inputType: 'insertFromPaste', data: null, isComposing: false }, 'pasted words');

    expect(sentInput(ws)).toEqual([{ type: 'text', value: 'pasted words' }]);
  });

  it('a composition sends the committed word once, when it ends', async () => {
    const ws = await connected();
    const input = hiddenInput();

    compose(input, 'word');
    expect(sentInput(ws)).toEqual([]);
    fire(input, 'compositionend', { data: 'word' });
    // Some browsers follow compositionend with a plain input event for the same word.
    fire(input, 'input', { inputType: 'insertText', data: 'word', isComposing: false });

    expect(sentInput(ws)).toEqual([{ type: 'text', value: 'word' }]);
    expect(input.value).toBe('');
  });

  it('Enter during a composition sends the word first, then the key', async () => {
    const ws = await connected();
    const input = hiddenInput();

    compose(input, 'hello');
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    fire(input, 'compositionend', { data: 'hello' });

    expect(sentInput(ws)).toEqual([
      { type: 'text', value: 'hello' },
      { type: 'key', key: 'Enter' },
    ]);
  });

  it('insertLineBreak sends Enter', async () => {
    const ws = await connected();

    fire(hiddenInput(), 'beforeinput', { inputType: 'insertLineBreak', data: null });

    expect(sentInput(ws)).toEqual([{ type: 'key', key: 'Enter' }]);
  });

  it('deleteContentBackward on the empty input (Android, key Unidentified) sends Backspace, never twice', async () => {
    const ws = await connected();
    const input = hiddenInput();
    const deleteBackward = () => fire(input, 'beforeinput', { inputType: 'deleteContentBackward', data: null });

    fireEvent.keyDown(input, { key: 'Unidentified', keyCode: 229 });
    deleteBackward();
    fireEvent.keyDown(input, { key: 'Backspace', keyCode: 8 });
    deleteBackward();
    fireEvent.keyUp(input, { key: 'Backspace', keyCode: 8 });

    expect(sentInput(ws)).toEqual([
      { type: 'key', key: 'Backspace' },
      { type: 'key', key: 'Backspace' },
    ]);
  });

  it('deleting inside a composition only edits the word', async () => {
    const ws = await connected();
    const input = hiddenInput();

    compose(input, 'wox');
    fire(input, 'beforeinput', { inputType: 'deleteContentBackward', data: null, isComposing: true });
    fire(input, 'input', { inputType: 'deleteContentBackward', data: null, isComposing: true }, 'wo');
    fire(input, 'compositionend', { data: 'wo' });

    expect(sentInput(ws)).toEqual([{ type: 'text', value: 'wo' }]);
  });

  it('the Keyboard button focuses the hidden input', async () => {
    await connected();

    fireEvent.click(screen.getByRole('button', { name: /preview\.browser\.liveKeyboard/ }));

    expect(document.activeElement).toBe(hiddenInput());
  });

  it('a tap on the picture sends the tap, then focuses the input so the phone keyboard opens', async () => {
    const ws = await connected();
    await showFrame(ws);
    const surface = screen.getByRole('img');
    layOutView(surface);
    vi.useFakeTimers();

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 100, clientY: 50 });
    act(() => vi.advanceTimersByTime(300));

    expect(ws.messages().filter((m) => m.type === 'tap')).toHaveLength(1);
    expect(document.activeElement).toBe(hiddenInput());
  });

  it('the hidden input is 16px, so iOS does not zoom when it is focused', async () => {
    await connected();

    expect(hiddenInput().style.fontSize).toBe('16px');
  });
});
