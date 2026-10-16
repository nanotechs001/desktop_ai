/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// AgentLogoIcon lives in AgentBadge but is a named export consumed by
// AgentModeSelector, MobileConversationBrand, and ChatLayout.
import { AgentLogoIcon } from '@/renderer/components/agent/AgentBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@icon-park/react', () => ({
  Robot: ({ className, fill }: { className?: string; fill?: string; size?: number }) => (
    <span data-testid='robot-fallback' className={className} data-fill={fill} />
  ),
}));

describe('AgentLogoIcon', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('<svg></svg>') }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('passes the agent logo through ThemedLogo', async () => {
    const { container } = render(
      <AgentLogoIcon agent_name='Writer' agentLogo='http://127.0.0.1:1/api/assets/logos/writer.svg' />
    );

    // Wait for ThemedLogo's detection fetch to settle
    await act(async () => {
      await Promise.resolve();
    });

    // Non-tintable SVG (no currentColor in stub) → renders as <img>
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('alt')).toBe('Writer logo');
    expect(img?.getAttribute('src')).toContain('writer.svg');
  });

  it('renders an emoji avatar', () => {
    render(<AgentLogoIcon agentLogo='🤖' />);

    expect(screen.getByText('🤖')).toBeInTheDocument();
  });

  it('renders the Robot fallback when no logo is available', () => {
    render(<AgentLogoIcon />);

    expect(screen.getByTestId('robot-fallback')).toBeInTheDocument();
  });

  it('renders fallback when agentLogoIsFallback is set', () => {
    render(<AgentLogoIcon agentLogoIsFallback />);

    expect(screen.getByTestId('robot-fallback')).toBeInTheDocument();
  });
});
