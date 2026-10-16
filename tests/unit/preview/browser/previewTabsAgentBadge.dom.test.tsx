/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PreviewTabs from '@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewTabs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const BADGE = 'preview.browserChrome.agent.badge';

const renderTabs = (agentOwned?: boolean) =>
  render(
    <PreviewTabs
      tabs={[{ id: 't1', title: 'Example', agentOwned }]}
      activeTabId='t1'
      tabFadeState={{ left: false, right: false }}
      tabsContainerRef={React.createRef<HTMLDivElement>()}
      onSwitchTab={vi.fn()}
      onCloseTab={vi.fn()}
      onContextMenu={vi.fn()}
      onClosePanel={vi.fn()}
    />
  );

afterEach(cleanup);

describe('PreviewTabs agent badge', () => {
  it('shows the Agent badge on an agent-owned tab', () => {
    renderTabs(true);
    expect(screen.getByText(BADGE)).toBeTruthy();
  });

  it('shows no badge on a user tab', () => {
    renderTabs(false);
    expect(screen.queryByText(BADGE)).toBeNull();
  });
});
