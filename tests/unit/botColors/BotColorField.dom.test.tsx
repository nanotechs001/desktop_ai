/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_COLOR_PALETTE } from '@/common/types/agent/botColors';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

import BotColorField from '@/renderer/pages/settings/AssistantSettings/editor/BotColorField';

afterEach(cleanup);

const renderField = (value: string, onChange = vi.fn()) => {
  render(
    <ConfigProvider>
      <BotColorField value={value} onChange={onChange} />
    </ConfigProvider>
  );
  return onChange;
};

describe('BotColorField', () => {
  it('shows the 12 palette swatches, each named by its color', () => {
    renderField(BOT_COLOR_PALETTE[0]);
    for (const color of BOT_COLOR_PALETTE) {
      expect(screen.getByRole('button', { name: color })).toBeInTheDocument();
    }
  });

  it('marks the current color as pressed, ignoring letter case', () => {
    renderField(BOT_COLOR_PALETTE[3].toUpperCase());
    expect(screen.getByRole('button', { name: BOT_COLOR_PALETTE[3] })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: BOT_COLOR_PALETTE[4] })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports a clicked swatch', () => {
    const onChange = renderField(BOT_COLOR_PALETTE[0]);
    fireEvent.click(screen.getByRole('button', { name: BOT_COLOR_PALETTE[5] }));
    expect(onChange).toHaveBeenCalledWith(BOT_COLOR_PALETTE[5]);
  });

  it('offers a custom color picker showing the current color', () => {
    renderField('#123abc');
    expect(screen.getByTestId('bot-color-custom')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '#123abc' })).not.toBeInTheDocument();
  });
});
