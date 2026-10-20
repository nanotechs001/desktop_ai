/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The preview tab bar's "new browser tab" plus opens a `<webview>` tab, which only the Electron desktop can show.
 * On the phone (the WebUI) the browser tab is the live view of the agent's tab, so the plus is hidden there.
 */

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light' }),
}));

vi.mock('@/common', () => ({
  ipcBridge: (() => {
    const officePreview = {
      status: { on: () => () => {} },
      start: { invoke: async () => ({ error: 'OFFICECLI_NOT_FOUND' }) },
      stop: { invoke: async () => undefined },
    };
    return {
      fileStream: { contentUpdate: { on: () => () => {} } },
      preview: { open: { on: () => () => {} } },
      shell: { openFile: { invoke: async () => undefined } },
      excelPreview: officePreview,
      wordPreview: officePreview,
      pptPreview: officePreview,
      fs: {
        writeContent: { invoke: async () => true },
        getContentMetadata: { invoke: async () => null },
        readContent: { invoke: async () => null },
        openSystem: { invoke: async () => undefined },
        writeFile: { invoke: async () => true },
        getFileMetadata: { invoke: async () => null },
        getImageBase64: { invoke: async () => null },
      },
    };
  })(),
}));

import PreviewPanel from '@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewPanel';
import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';

let ctx: PreviewContextValue;
const Probe: React.FC = () => {
  ctx = usePreviewContext();
  return null;
};

/** The panel is mounted only once a tab is open (it changes its hook count across closed -> open). */
const Harness: React.FC<{ showPanel: boolean }> = ({ showPanel }) => (
  <PreviewProvider>
    <Probe />
    {showPanel ? <PreviewPanel /> : null}
  </PreviewProvider>
);

const renderWithATab = (): void => {
  const { rerender } = render(<Harness showPanel={false} />);
  act(() => {
    ctx.openPreview('', 'unsupported', {
      title: 'photo.heic',
      file_name: 'photo.heic',
      language: 'heic',
      fileRef: { kind: 'project', pe_id: 'peA', relative_path: 'pics/photo.heic' },
      editable: false,
    });
  });
  act(() => rerender(<Harness showPanel />));
};

const NEW_TAB = 'preview.browser.newTab';
const TIMEOUT_MS = 30000;
let electronApiStub: unknown;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 }))
  );
  electronApiStub = (window as Window & { electronAPI?: unknown }).electronAPI;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  (window as Window & { electronAPI?: unknown }).electronAPI = electronApiStub;
});

describe('PreviewPanel new browser tab plus', () => {
  it(
    'is hidden outside Electron',
    async () => {
      delete (window as Window & { electronAPI?: unknown }).electronAPI;
      renderWithATab();

      expect(await screen.findByText('photo.heic')).toBeInTheDocument();
      expect(screen.queryByTitle(NEW_TAB)).toBeNull();
    },
    TIMEOUT_MS
  );

  it(
    'is shown in Electron once the panel holds a tab',
    async () => {
      (window as Window & { electronAPI?: unknown }).electronAPI = {};
      renderWithATab();

      expect(await screen.findByTitle(NEW_TAB)).toBeInTheDocument();
    },
    TIMEOUT_MS
  );
});
