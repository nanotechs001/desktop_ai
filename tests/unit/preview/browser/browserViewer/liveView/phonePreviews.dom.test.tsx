/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// The WebUI has no <webview>: web links and PDFs open in a new tab of the phone's own browser.

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: { shell: { openFile: { invoke: vi.fn() } } } }));
// A stable `t`, as react-i18next gives: the PDF viewer's load effect depends on it.
const t = (key: string): string => key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('@/renderer/components/media/WebviewHost', () => ({
  default: ({ url }: { url: string }) => <div data-testid='webview-host'>{url}</div>,
}));

import URLViewer from '@/renderer/pages/conversation/Preview/components/viewers/URLViewer';
import PDFPreview from '@/renderer/pages/conversation/Preview/components/viewers/PDFViewer';
import { buildPdfSrc } from '@/renderer/pages/conversation/Preview/previewUrls';

const electronAPI = window.electronAPI;
const asWebUI = (): void => {
  // @ts-expect-error -- a plain browser has no preload bridge
  delete window.electronAPI;
};

afterEach(() => {
  cleanup();
  window.electronAPI = electronAPI;
  vi.restoreAllMocks();
});

describe('URLViewer', () => {
  it('shows the address and an Open button in the WebUI', () => {
    asWebUI();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<URLViewer url='https://example.com/a' />);

    expect(screen.getByText('https://example.com/a')).toBeInTheDocument();
    expect(screen.queryByTestId('webview-host')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'preview.browser.openLink' }));
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer');
  });

  it('offers no Open button for a non-web address in the WebUI', () => {
    asWebUI();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<URLViewer url='javascript:alert(1)' />);
    expect(screen.queryByRole('button', { name: 'preview.browser.openLink' })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps the webview in Electron', () => {
    render(<URLViewer url='https://example.com/a' />);
    expect(screen.getByTestId('webview-host')).toHaveTextContent('https://example.com/a');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('PDFPreview', () => {
  const fileRef = { kind: 'project' as const, pe_id: 'pe1', relative_path: 'docs/report.pdf' };

  it('shows the file name and opens the stream url in a new tab in the WebUI', () => {
    asWebUI();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { container } = render(<PDFPreview fileRef={fileRef} hideToolbar />);

    expect(container.querySelector('webview')).toBeNull();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'preview.pdf.open' }));
    const src = buildPdfSrc(fileRef);
    expect(src).toMatch(/^\/api\/fs\/stream\?/);
    expect(open).toHaveBeenCalledWith(src, '_blank', 'noopener,noreferrer');
  });

  it('keeps the webview in Electron', () => {
    const { container } = render(<PDFPreview fileRef={fileRef} hideToolbar />);
    expect(container.querySelector('webview')?.getAttribute('src')).toBe(buildPdfSrc(fileRef));
    expect(screen.queryByRole('button', { name: 'preview.pdf.open' })).toBeNull();
  });
});
