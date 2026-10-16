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
  frameOrigin: `https://${id}.test`,
  label: `Publish ${id}`,
  clientLabel: 'aion-browser-claude',
  ...patch,
});

const mount = async (initial: ConfirmRequest[] = []) => {
  mocks.getConfirmRequests.mockResolvedValue({ success: true, data: initial });
  render(<ConfirmPrompt />);
  await act(async () => {});
};

/** Waits out the delay before Allow turns on. */
const armAllow = () => act(async () => new Promise((resolve) => setTimeout(resolve, 520)));

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
    await armAllow();
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    expect(mocks.replyConfirm).toHaveBeenLastCalledWith({ id: 'a', allow: true, alwaysForSite: false });

    fireEvent.click(screen.getByText(`${KEY}.always`));
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    expect(mocks.replyConfirm).toHaveBeenLastCalledWith({ id: 'a', allow: true, alwaysForSite: true });
  });

  it('gives the first focus to Deny, not to the always-allow box or Allow', async () => {
    await mount([request('a')]);
    expect(document.activeElement?.textContent).toBe(`${KEY}.deny`);
  });

  it('keeps Allow off for 500 ms after an ask appears, and again when the next ask replaces it', async () => {
    await mount([request('a'), request('b')]);
    const allow = () => screen.getByText(`${KEY}.allow`).closest('button') as HTMLButtonElement;
    expect(allow().disabled).toBe(true);
    fireEvent.click(allow());
    expect(mocks.replyConfirm).not.toHaveBeenCalled();

    await armAllow();
    expect(allow().disabled).toBe(false);
    await push([request('b')]);
    expect(allow().disabled).toBe(true);
    fireEvent.click(allow());
    expect(mocks.replyConfirm).not.toHaveBeenCalled();
    // Deny is never delayed.
    fireEvent.click(screen.getByText(`${KEY}.deny`));
    expect(mocks.replyConfirm).toHaveBeenCalledWith({ id: 'b', allow: false, alwaysForSite: false });
  });

  it('names the frame origin only when the control sits in a frame of another origin', async () => {
    await mount([request('a')]);
    expect(screen.queryByText(/confirm\.frame/)).toBeNull();
    await push([request('a', { frameOrigin: 'https://pay.test' })]);
    expect(screen.getByText(`${KEY}.frame @ https://pay.test`)).toBeTruthy();
  });

  it('says a sandboxed frame cannot be remembered, and offers no always-allow box for it', async () => {
    await mount([request('a', { frameOrigin: null })]);
    expect(screen.getByText(`${KEY}.frameOpaque`)).toBeTruthy();
    expect(screen.queryByText(`${KEY}.always`)).toBeNull();
    await armAllow();
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    expect(mocks.replyConfirm).toHaveBeenCalledWith({ id: 'a', allow: true, alwaysForSite: false });
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
    await armAllow();
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
