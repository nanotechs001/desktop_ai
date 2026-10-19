/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (key: string) => mocks.store.get(key),
    subscribe: () => () => {},
  },
}));

import BotColorDot, { VaBotColorDot } from '@/renderer/components/agent/BotColorDot';

afterEach(cleanup);

describe('BotColorDot', () => {
  it('renders nothing without a color', () => {
    const { container } = render(<BotColorDot />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['red', 'red;', 'url(x)', '#abc', '#12345g', 'rgb(0,0,0)', '#112233; background: red'])(
    'renders nothing for the invalid color %j',
    (color) => {
      const { container } = render(<BotColorDot color={color} />);
      expect(container).toBeEmptyDOMElement();
    }
  );

  it('paints a small round dot hidden from assistive tech', () => {
    const { container } = render(<BotColorDot color='#3e63dd' />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot).toHaveAttribute('aria-hidden', 'true');
    expect(dot.style.backgroundColor).toBe('rgb(62, 99, 221)');
    expect(dot.style.width).toBe('8px');
    expect(dot.style.height).toBe('8px');
  });

  it('takes a custom size and extra class', () => {
    const { container } = render(<BotColorDot color='#3e63dd' size={12} className='ms-4px' />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.style.width).toBe('12px');
    expect(dot).toHaveClass('ms-4px');
  });
});

describe('VaBotColorDot', () => {
  it('shows the stored color of a user-made VA Bot', () => {
    mocks.store.set('agent.colors', { bot: '#3e63dd' });
    const { container } = render(<VaBotColorDot assistant={{ id: 'bot', source: 'user' }} size={10} />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.style.backgroundColor).toBe('rgb(62, 99, 221)');
    expect(dot.style.width).toBe('10px');
  });

  it.each([
    ['a built-in Agent', { id: 'bot', source: 'builtin' }],
    ['an engine-generated Agent', { id: 'bot', source: 'generated' }],
    ['no Agent', undefined],
  ])('renders nothing for %s', (_label, assistant) => {
    mocks.store.set('agent.colors', { bot: '#3e63dd' });
    const { container } = render(<VaBotColorDot assistant={assistant} />);
    expect(container).toBeEmptyDOMElement();
  });
});
