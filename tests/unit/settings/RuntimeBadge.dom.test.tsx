/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Assistant } from '@/common/types/agent/assistantTypes';

const mocks = vi.hoisted(() => ({
  pins: { current: undefined as Record<string, string> | undefined },
  engines: { current: undefined as unknown },
  language: { current: 'en-US' },
}));

const LABELS: Record<string, string> = { 'agent.engine.label': 'Engine', 'agent.engine.useDefault': 'Use default' };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => LABELS[key] ?? options?.defaultValue ?? key,
    i18n: { language: mocks.language.current },
  }),
}));

vi.mock('swr', () => ({ default: () => ({ data: mocks.engines.current }) }));
vi.mock('@/renderer/hooks/config/useConfig', () => ({ useConfig: () => [mocks.pins.current, vi.fn()] }));
vi.mock('@/renderer/utils/model/agentTypes', () => ({
  ENGINE_CATALOG_SWR_KEY: 'agents.managed.engines',
  fetchManagedAgentsOrThrow: vi.fn(),
}));

import RuntimeBadge from '@/renderer/pages/settings/AssistantSettings/home/RuntimeBadge';

const makeAssistant = (overrides: Partial<Assistant> = {}): Assistant => ({
  id: 'a1',
  source: 'user',
  name: 'Writer',
  name_i18n: {},
  description_i18n: {},
  enabled: true,
  sort_order: 1,
  agent_id: 'engine-1',
  agent: { type: 'claude', source: 'internal' },
  enabled_skills: [],
  custom_skill_names: [],
  disabled_builtin_skills: [],
  context_i18n: {},
  prompts: [],
  ...overrides,
});

describe('RuntimeBadge', () => {
  beforeEach(() => {
    mocks.pins.current = undefined;
    mocks.language.current = 'en-US';
    mocks.engines.current = [
      { id: 'engine-1', name: 'Engine One', name_i18n: { 'zh-CN': '引擎一' } },
      { id: 'engine-2', name: 'Engine Two' },
    ];
  });

  it('shows the pinned engine by name', () => {
    mocks.pins.current = { a1: 'engine-2' };
    render(<RuntimeBadge assistant={makeAssistant()} />);
    expect(screen.getByTestId('assistant-runtime-a1')).toHaveTextContent('Engine: Engine Two');
  });

  it('shows "Use default" for an Agent without a pin, whatever engine it currently runs on', () => {
    render(<RuntimeBadge assistant={makeAssistant()} />);
    expect(screen.getByTestId('assistant-runtime-a1')).toHaveTextContent('Engine: Use default');
  });

  it('shows a bare CLI entry on its own engine', () => {
    render(<RuntimeBadge assistant={makeAssistant({ source: 'generated', agent_id: 'engine-1' })} />);
    expect(screen.getByTestId('assistant-runtime-a1')).toHaveTextContent('Engine: Engine One');
  });

  it('uses the localized engine name', () => {
    mocks.language.current = 'zh-CN';
    render(<RuntimeBadge assistant={makeAssistant({ source: 'generated', agent_id: 'engine-1' })} />);
    expect(screen.getByTestId('assistant-runtime-a1')).toHaveTextContent('Engine: 引擎一');
  });

  it('shows only the label while the engine list is loading or the engine is gone', () => {
    mocks.pins.current = { a1: 'removed-engine' };
    const { rerender } = render(<RuntimeBadge assistant={makeAssistant()} />);
    expect(screen.getByTestId('assistant-runtime-a1').textContent).toBe('Engine');

    mocks.engines.current = undefined;
    rerender(<RuntimeBadge assistant={makeAssistant()} />);
    expect(screen.getByTestId('assistant-runtime-a1').textContent).toBe('Engine');
  });

  it('never renders a logo', () => {
    const { container } = render(<RuntimeBadge assistant={makeAssistant({ source: 'generated' })} framed />);
    expect(container.querySelector('img, svg')).toBeNull();
  });
});
