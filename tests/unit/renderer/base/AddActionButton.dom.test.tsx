/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AddActionButton from '@/renderer/components/base/AddActionButton';

const TEST_ID = 'btn-add';

afterEach(cleanup);

describe('AddActionButton', () => {
  it('is a plain button that runs the manual action when it is the only action', () => {
    const onManual = vi.fn();
    render(<AddActionButton label='Add' onManual={onManual} data-testid={TEST_ID} />);

    fireEvent.click(screen.getByTestId(TEST_ID));

    expect(onManual).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });

  it('opens a menu instead of acting when there are extra actions', async () => {
    const onManual = vi.fn();
    const onJson = vi.fn();
    render(
      <AddActionButton
        label='Add'
        onManual={onManual}
        manualLabel='Manual'
        extraActions={[{ key: 'json', label: 'From JSON', onClick: onJson }]}
        data-testid={TEST_ID}
      />
    );

    fireEvent.click(screen.getByTestId(TEST_ID));
    expect(onManual).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText('From JSON'));
    expect(onJson).toHaveBeenCalledTimes(1);
    expect(onManual).not.toHaveBeenCalled();
  });

  it('offers "via chat" only when both onChat and chatLabel are given', async () => {
    const onChat = vi.fn();
    const { rerender } = render(
      <AddActionButton label='Add' onChat={onChat} onManual={vi.fn()} manualLabel='Manual' data-testid={TEST_ID} />
    );
    // onChat without chatLabel: nothing to choose between, so the button acts directly
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(TEST_ID));
    expect(onChat).not.toHaveBeenCalled();

    rerender(
      <AddActionButton label='Add' chatLabel='Via chat' onManual={vi.fn()} manualLabel='Manual' data-testid={TEST_ID} />
    );
    // chatLabel without onChat: also no chat item
    fireEvent.click(screen.getByTestId(TEST_ID));
    expect(screen.queryByText('Via chat')).not.toBeInTheDocument();

    rerender(
      <AddActionButton
        label='Add'
        onChat={onChat}
        chatLabel='Via chat'
        onManual={vi.fn()}
        manualLabel='Manual'
        data-testid={TEST_ID}
      />
    );
    fireEvent.click(screen.getByTestId(TEST_ID));
    fireEvent.click(await screen.findByText('Via chat'));
    expect(onChat).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });
});
