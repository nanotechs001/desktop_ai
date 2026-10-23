/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Settings → in-app browser: cookie import goes into a bot's or the Agent's profile, picked next to the button.
 * There is no Personal profile any more, so it never targets Personal.
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ targets: [] as unknown[] }));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { getCdpStatus: { invoke: () => Promise.resolve({ data: { enabled: true, configEnabled: true } }) } },
    assistants: {
      list: {
        invoke: () =>
          Promise.resolve([
            { id: 'aion-default-agent', name: 'Agent', source: 'user' },
            { id: 'bot-1', name: 'DG Assistant', source: 'user' },
          ]),
      },
    },
  },
}));

vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserProfiles/CookieImportModal', () => ({
  default: ({ target }: { target: unknown }) => {
    h.targets.push(target);
    return null;
  },
  isCookieImportSupported: () => true,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import BrowserDataSection from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/BrowserDataSection';

afterEach(() => {
  cleanup();
  h.targets = [];
});

describe('Settings cookie import', () => {
  it("imports into the Agent's profile by default, offers the bots, and never targets Personal", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <BrowserDataSection />
      </SWRConfig>
    );
    expect(await screen.findByLabelText('settings.browserData.importProfile')).toBeTruthy();
    await waitFor(() => expect(h.targets.at(-1)).toEqual({ kind: 'agent', agentId: 'aion-default-agent' }));
    expect(h.targets).not.toContainEqual({ kind: 'personal' });
  });
});
