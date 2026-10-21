/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageAcpToolCall, IMessageText, TMessage } from '@/common/chat/chatLib';
import MessageFileLinks from '@/renderer/pages/conversation/Messages/fileLinks/MessageFileLinks';
import { useAutoOpenTurnFiles } from '@/renderer/pages/conversation/Messages/fileLinks/useAutoOpenTurnFiles';

const { openPreview, resolvePreviewPayload, previewState } = vi.hoisted(() => ({
  openPreview: vi.fn(),
  resolvePreviewPayload: vi.fn(),
  previewState: { isVaBotMode: false },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key),
  }),
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openPreview, isVaBotMode: previewState.isVaBotMode }),
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({ conversation_id: 'c1', workspace: '/ws' }),
}));

vi.mock('@/renderer/pages/conversation/explorer/currentProjectStore', () => ({
  getCurrentProject: () => null,
}));

vi.mock('@/renderer/utils/file/previewPayload', () => ({
  upgradeFileRef: async <T,>(ref: T) => ref,
  resolvePreviewPayload: (...args: unknown[]) => resolvePreviewPayload(...args),
}));

const payload = { content: '', oversized: false, sizeBytes: 10, lastModified: 5 };

describe('MessageFileLinks', () => {
  beforeEach(() => {
    openPreview.mockReset();
    resolvePreviewPayload.mockReset();
    resolvePreviewPayload.mockResolvedValue(payload);
    previewState.isVaBotMode = false;
  });

  it('opens a binary document through the explorer payload path', async () => {
    render(<MessageFileLinks files={[{ path: 'out/report.docx', name: 'report.docx', key: 'out/report.docx' }]} />);

    fireEvent.click(screen.getByRole('button', { name: 'messages.fileLinks.openFileAria:report.docx' }));

    await waitFor(() => expect(openPreview).toHaveBeenCalledTimes(1));
    expect(resolvePreviewPayload).toHaveBeenCalledWith({ kind: 'local', path: '/ws/out/report.docx' }, 'word');
    const [content, type, metadata, options] = openPreview.mock.calls[0];
    expect(content).toBe('');
    expect(type).toBe('word');
    expect(metadata).toMatchObject({ file_name: 'report.docx', file_path: '/ws/out/report.docx', lastModified: 5 });
    // Never replaces the active tab (it may be a browser page).
    expect(options).toBeUndefined();
  });

  it('keeps absolute paths and shows the missing-file state when the read fails', async () => {
    resolvePreviewPayload.mockRejectedValue(new Error('ENOENT'));
    render(<MessageFileLinks files={[{ path: 'C:\\out\\page.html', name: 'page.html', key: 'c:/out/page.html' }]} />);

    fireEvent.click(screen.getByTestId('message-file-link'));

    await waitFor(() => expect(openPreview).toHaveBeenCalledTimes(1));
    expect(openPreview.mock.calls[0][1]).toBe('html');
    expect(openPreview.mock.calls[0][2]).toMatchObject({ file_path: 'C:\\out\\page.html', missingFile: true });
  });

  it('renders nothing without files', () => {
    const { container } = render(<MessageFileLinks files={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

const user: IMessageText = {
  id: 'u1',
  conversation_id: 'c1',
  type: 'text',
  position: 'right',
  created_at: 1,
  content: { content: 'make a page' },
};

const write = (status: 'in_progress' | 'completed', created_at: number, id = 'w1'): IMessageAcpToolCall => ({
  id,
  conversation_id: 'c1',
  type: 'acp_tool_call',
  position: 'left',
  created_at,
  content: {
    sessionId: 's1',
    update: {
      sessionUpdate: 'tool_call_update',
      tool_call_id: id,
      status,
      title: 'Write',
      kind: 'edit',
      rawInput: { file_path: '/ws/index.html' },
    },
  },
});

describe('useAutoOpenTurnFiles', () => {
  beforeEach(() => {
    openPreview.mockReset();
    resolvePreviewPayload.mockReset();
    resolvePreviewPayload.mockResolvedValue({ ...payload, content: '<p>x</p>' });
    previewState.isVaBotMode = false;
  });

  it('opens a document once when a live tool call completes, never for history', async () => {
    const history: TMessage[] = [user, write('completed', 2)];
    const { rerender } = renderHook(({ messages }) => useAutoOpenTurnFiles('c1', messages), {
      initialProps: { messages: history },
    });
    expect(openPreview).not.toHaveBeenCalled();

    // A history stamp, but seen unfinished first: the call is live.
    rerender({ messages: [user, write('in_progress', 3, 'w2')] });
    const live = write('completed', 3, 'w2');
    rerender({ messages: [user, live] });
    await waitFor(() => expect(openPreview).toHaveBeenCalledTimes(1));
    expect(openPreview.mock.calls[0].slice(0, 2)).toEqual(['<p>x</p>', 'html']);

    rerender({ messages: [user, { ...live }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openPreview).toHaveBeenCalledTimes(1);
  });

  it('does not auto-open in a robot window, whose files would pull the main window to the chat mid-turn', async () => {
    window.location.hash = '#/widget/c1';
    try {
      const { rerender } = renderHook(({ messages }) => useAutoOpenTurnFiles('c1', messages), {
        initialProps: { messages: [user] as TMessage[] },
      });
      rerender({ messages: [user, write('completed', Date.now() + 1000)] });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(openPreview).not.toHaveBeenCalled();
    } finally {
      window.location.hash = '';
    }
  });

  it('does not auto-open in VA Bot mode', async () => {
    previewState.isVaBotMode = true;
    const { rerender } = renderHook(({ messages }) => useAutoOpenTurnFiles('c1', messages), {
      initialProps: { messages: [user] as TMessage[] },
    });
    rerender({ messages: [user, write('completed', Date.now() + 1000)] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openPreview).not.toHaveBeenCalled();
  });
});
