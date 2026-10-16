import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  getConfirmRequests: vi.fn(),
  replyConfirm: vi.fn(() => Promise.resolve({ success: true })),
  handler: null as ((open: ConfirmRequest[]) => void) | null,
  unsubscribe: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentBrowser: {
      getConfirmRequests: { invoke: mocks.getConfirmRequests },
      replyConfirm: { invoke: mocks.replyConfirm },
      confirmRequested: {
        on: (handler: (open: ConfirmRequest[]) => void) => {
          mocks.handler = handler;
          return mocks.unsubscribe;
        },
      },
    },
  },
}));

// Interpolation is echoed so the test can see which origin the message was given.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { origin?: string }) => (opts?.origin ? `${key} @ ${opts.origin}` : key),
  }),
}));

import ConfirmPrompt from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/ConfirmPrompt';

const KEY = 'preview.browserChrome.confirm';

const request = (id: string, patch: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  id,
  origin: `https://${id}.test`,
  label: `Publish ${id}`,
  clientLabel: 'aion-browser-claude',
  ...patch,
});

const mount = async (initial: ConfirmRequest[] = []) => {
  mocks.getConfirmRequests.mockResolvedValue({ success: true, data: initial });
  render(<ConfirmPrompt />);
  await act(async () => {});
};

const push = (open: ConfirmRequest[]) => act(() => mocks.handler?.(open));

beforeEach(() => {
  mocks.replyConfirm.mockClear();
  mocks.unsubscribe.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ConfirmPrompt', () => {
  it('shows the action label and the origin as text, and nothing while no ask is open', async () => {
    await mount();
    expect(screen.queryByText(`${KEY}.allow`)).toBeNull();

    await push([request('a', { label: '<img src=x onerror=alert(1)>' })]);
    expect(screen.getByText(`${KEY}.message @ https://a.test`)).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(`${KEY}.title`)).toBeTruthy();
    // The prompt says "the agent" (vendor-neutral); the client's own label never appears.
    expect(screen.queryByText(/aion-browser-claude/)).toBeNull();
  });

  it('Allow replies allow without always-allow unless the box is checked', async () => {
    await mount([request('a')]);
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    expect(mocks.replyConfirm).toHaveBeenLastCalledWith({ id: 'a', allow: true, alwaysForSite: false });

    fireEvent.click(screen.getByText(`${KEY}.always`));
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    expect(mocks.replyConfirm).toHaveBeenLastCalledWith({ id: 'a', allow: true, alwaysForSite: true });
  });

  it('Deny never asks to remember the site, even with the box checked', async () => {
    await mount([request('a')]);
    fireEvent.click(screen.getByText(`${KEY}.always`));
    fireEvent.click(screen.getByText(`${KEY}.deny`));
    expect(mocks.replyConfirm).toHaveBeenCalledWith({ id: 'a', allow: false, alwaysForSite: false });
  });

  it.each([
    ['the close button', () => fireEvent.click(document.querySelector('.arco-modal-close-icon') as HTMLElement)],
    [
      'a mask click',
      () => {
        const wrapper = document.querySelector('.arco-modal-wrapper') as HTMLElement;
        fireEvent.mouseDown(wrapper);
        fireEvent.click(wrapper);
      },
    ],
    ['Esc', () => fireEvent.keyDown(screen.getByText(`${KEY}.always`), { key: 'Escape' })],
  ])('dismissing with %s denies', async (_name, dismiss) => {
    await mount([request('a')]);
    dismiss();
    // Arco defers a mask-click close by 100 ms.
    await waitFor(() =>
      expect(mocks.replyConfirm).toHaveBeenCalledWith({ id: 'a', allow: false, alwaysForSite: false })
    );
  });

  it('shows one ask at a time in order, and starts the next with the box unchecked', async () => {
    await mount([request('a'), request('b')]);
    expect(screen.getByText('Publish a')).toBeTruthy();
    expect(screen.queryByText('Publish b')).toBeNull();
    fireEvent.click(screen.getByText(`${KEY}.always`));

    await push([request('b')]);
    expect(screen.getByText('Publish b')).toBeTruthy();
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    expect(mocks.replyConfirm).toHaveBeenCalledWith({ id: 'b', allow: true, alwaysForSite: false });
  });

  it('closes when the ask is withdrawn, and keeps an event that arrived before the initial list', async () => {
    await mount([request('a')]);
    await push([]);
    expect(screen.queryByText(`${KEY}.allow`)).toBeNull();

    cleanup();
    const initial = Promise.withResolvers<unknown>();
    mocks.getConfirmRequests.mockReturnValue(initial.promise);
    render(<ConfirmPrompt />);
    await push([request('new')]);
    await act(async () => initial.resolve({ success: true, data: [request('old')] }));
    expect(screen.getByText('Publish new')).toBeTruthy();
  });

  it('unsubscribes on unmount', async () => {
    await mount();
    cleanup();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });
});
