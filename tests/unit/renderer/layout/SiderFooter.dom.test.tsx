/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import SiderFooter from '@renderer/components/layout/Sider/SiderFooter';

const renderFooter = (props: { collapsed: boolean; isSettings: boolean }) => {
  const onThemeToggle = vi.fn();
  render(
    <SiderFooter
      isMobile={false}
      theme='light'
      siderTooltipProps={{ disabled: true } as never}
      onSettingsClick={() => {}}
      onThemeToggle={onThemeToggle}
      {...props}
    />
  );
  return { onThemeToggle };
};

describe('SiderFooter theme toggle', () => {
  it('stays available in the icon-only rail while in settings', () => {
    const { onThemeToggle } = renderFooter({ collapsed: true, isSettings: true });

    fireEvent.click(screen.getByTestId('theme-toggle'));

    expect(onThemeToggle).toHaveBeenCalledTimes(1);
  });

  it('is absent outside settings', () => {
    renderFooter({ collapsed: true, isSettings: false });

    expect(screen.queryByTestId('theme-toggle')).toBeNull();
  });
});
