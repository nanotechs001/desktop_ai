/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DEFAULT_AGENT_WIDGET_SETTINGS } from '@/common/types/agent/agentWidget';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/renderer/pages/agentWidget/useAgentWidgetSync', () => ({
  useAgentWidgetSettings: () => ({ ...DEFAULT_AGENT_WIDGET_SETTINGS, enabled: false }),
}));
vi.mock('@/common', () => ({ ipcBridge: { agentWidget: {} } }));

import AgentWidgetSection from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/AgentWidgetSection';

const switchInRow = (label: string): HTMLElement => {
  const row = screen.getByText(label).closest('.justify-between');
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${label}`);
  return row.querySelector<HTMLElement>('[role="switch"]') ?? row.querySelector<HTMLElement>('button')!;
};

describe('AgentWidgetSection', () => {
  it('keeps the app-wide reduce-motion switch enabled while the robots are off', () => {
    render(<AgentWidgetSection />);

    expect(switchInRow('pet.widget.settings.reduceMotion')).not.toBeDisabled();
    expect(switchInRow('pet.widget.settings.alwaysOnTop')).toBeDisabled();
  });
});
