/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import BotColorDot from '@/renderer/components/agent/BotColorDot';

afterEach(cleanup);

describe('BotColorDot', () => {
  it('renders nothing without a color', () => {
    const { container } = render(<BotColorDot />);
    expect(container).toBeEmptyDOMElement();
  });

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
