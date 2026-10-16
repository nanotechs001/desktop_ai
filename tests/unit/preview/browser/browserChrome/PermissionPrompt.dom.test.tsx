/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  getPermissionRequests: vi.fn(),
  replyPermission: vi.fn(() => Promise.resolve({ success: true })),
  handler: null as ((open: PermissionRequest[]) => void) | null,
  unsubscribe: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    browser: {
      getPermissionRequests: { invoke: mocks.getPermissionRequests },
      replyPermission: { invoke: mocks.replyPermission },
      permissionRequested: {
        on: (handler: (open: PermissionRequest[]) => void) => {
          mocks.handler = handler;
          return mocks.unsubscribe;
        },
      },
    },
  },
}));

// Interpolation is echoed so the test can see which message and origin were chosen.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { origin?: string }) => (opts?.origin ? `${key} @ ${opts.origin}` : key),
  }),
}));

import PermissionPrompt from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/PermissionPrompt';

const KEY = 'preview.browserChrome.permission';

const request = (id: string, patch: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id,
  origin: `https://${id}.test`,
  permission: 'media',
  mediaTypes: ['video', 'audio'],
  ...patch,
});

const mount = async (initial: PermissionRequest[] = []) => {
  mocks.getPermissionRequests.mockResolvedValue({ success: true, data: initial });
  render(<PermissionPrompt />);
  await act(async () => {});
};

const push = (open: PermissionRequest[]) => act(() => mocks.handler?.(open));

beforeEach(() => {
  mocks.replyPermission.mockClear();
  mocks.unsubscribe.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('PermissionPrompt', () => {
  it('shows the camera-and-microphone prompt for media and replies allow with remember checked', async () => {
    await mount();
    expect(screen.queryByText(`${KEY}.allow`)).toBeNull();

    await push([request('a')]);
    expect(screen.getByText(`${KEY}.media @ https://a.test`)).toBeTruthy();
    fireEvent.click(screen.getByText(`${KEY}.allow`));

    expect(mocks.replyPermission).toHaveBeenCalledWith({ id: 'a', allow: true, remember: true });
  });

  it('names only the camera or only the microphone when one media type is requested', async () => {
    await mount([request('a', { mediaTypes: ['video'] })]);
    expect(screen.getByText(`${KEY}.mediaCamera @ https://a.test`)).toBeTruthy();
    await push([request('a', { mediaTypes: ['audio'] })]);
    expect(screen.getByText(`${KEY}.mediaMicrophone @ https://a.test`)).toBeTruthy();
  });

  it('Block replies allow:false; the prompt disappears when the request list empties', async () => {
    await mount([request('a', { permission: 'geolocation', mediaTypes: [] })]);
    expect(screen.getByText(`${KEY}.geolocation @ https://a.test`)).toBeTruthy();

    fireEvent.click(screen.getByText(`${KEY}.block`));
    expect(mocks.replyPermission).toHaveBeenCalledWith({ id: 'a', allow: false, remember: true });

    await push([]);
    expect(screen.queryByText(`${KEY}.block`)).toBeNull();
  });

  const wrapper = () => document.querySelector('.arco-modal-wrapper') as HTMLElement;
  it.each([
    ['the close button', () => fireEvent.click(document.querySelector('.arco-modal-close-icon') as HTMLElement)],
    [
      'a mask click',
      () => {
        fireEvent.mouseDown(wrapper());
        fireEvent.click(wrapper());
      },
    ],
    ['Esc', () => fireEvent.keyDown(screen.getByText(`${KEY}.remember`), { key: 'Escape' })],
  ])('dismissing with %s replies Block without remembering', async (_name, dismiss) => {
    await mount([request('a')]);
    dismiss();
    // Arco defers a mask-click close by 100 ms.
    await waitFor(() => expect(mocks.replyPermission).toHaveBeenCalledWith({ id: 'a', allow: false, remember: false }));
  });

  it('honours an unchecked remember box', async () => {
    await mount([request('a')]);
    fireEvent.click(screen.getByText(`${KEY}.remember`));
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    expect(mocks.replyPermission).toHaveBeenCalledWith({ id: 'a', allow: true, remember: false });
  });

  it('shows one request at a time in order, and re-checks remember for the next one', async () => {
    await mount([request('a'), request('b')]);
    expect(screen.getByText(`${KEY}.media @ https://a.test`)).toBeTruthy();
    expect(screen.queryByText(`${KEY}.media @ https://b.test`)).toBeNull();
    fireEvent.click(screen.getByText(`${KEY}.remember`));

    await push([request('b')]);
    expect(screen.getByText(`${KEY}.media @ https://b.test`)).toBeTruthy();
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    expect(mocks.replyPermission).toHaveBeenCalledWith({ id: 'b', allow: true, remember: true });
  });

  it('keeps an event that arrived before the initial list', async () => {
    let resolveInitial: (value: unknown) => void = () => {};
    mocks.getPermissionRequests.mockReturnValue(new Promise((resolve) => (resolveInitial = resolve)));
    render(<PermissionPrompt />);
    await push([request('new')]);
    await act(async () => resolveInitial({ success: true, data: [request('old')] }));
    expect(screen.getByText(`${KEY}.media @ https://new.test`)).toBeTruthy();
  });

  it('unsubscribes on unmount', async () => {
    await mount();
    cleanup();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });
});
