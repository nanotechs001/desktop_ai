/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { layoutState } = vi.hoisted(() => ({
  layoutState: { isMobile: false },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      listAvailableSkills: { invoke: vi.fn().mockResolvedValue([]) },
      listWorkspaceFiles: { invoke: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('@/renderer/hooks/chat/useInputFocusRing', () => ({
  useInputFocusRing: () => ({
    activeBorderColor: 'var(--color-primary-6)',
    inactiveBorderColor: 'var(--color-border-2)',
    activeShadow: 'none',
  }),
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({
    conversation_id: 'sendbox-active-focus-conversation',
    type: 'acp',
  }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: layoutState.isMobile }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    setSendBoxHandler: vi.fn(),
    domSnippets: [],
    removeDomSnippet: vi.fn(),
    clearDomSnippets: vi.fn(),
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useMessageList: () => [],
}));

vi.mock('@/renderer/hooks/file/useConversationExport', () => ({
  useConversationExport: () => ({
    isOpen: false,
    showMenu: false,
    step: 'menu',
    filename: '',
    pathPreview: '',
    menuItems: [],
    activeIndex: 0,
    loading: false,
    openExportFlow: vi.fn(),
    closeExportFlow: vi.fn(),
    handleKeyDown: vi.fn(),
    onSelectMenuItem: vi.fn(),
    setActiveIndex: vi.fn(),
    setFilename: vi.fn(),
    submitFilename: vi.fn(),
  }),
}));

vi.mock('@/renderer/components/chat/BtwOverlay/useBtwCommand', () => ({
  useBtwCommand: () => ({
    answer: '',
    question: '',
    isLoading: false,
    isOpen: false,
    ask: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('@/renderer/hooks/file/useDragUpload', () => ({
  useDragUpload: () => ({ isFileDragging: false, dragHandlers: {} }),
}));

vi.mock('@/renderer/hooks/file/usePasteService', () => ({
  usePasteService: () => ({ onPaste: vi.fn(), onFocus: vi.fn() }),
}));

vi.mock('@/renderer/hooks/file/useUploadState', () => ({
  useUploadState: () => ({ isUploading: false }),
}));

vi.mock('@/renderer/hooks/file/useAbortUploadsOnConversationChange', () => ({
  useAbortUploadsOnConversationChange: vi.fn(),
}));

vi.mock('@/renderer/hooks/system/useLiveTranscriptInsertion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/renderer/hooks/system/useLiveTranscriptInsertion')>();
  return {
    ...actual,
    useLiveTranscriptInsertion: () => ({ handleLiveTranscript: vi.fn() }),
  };
});

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: { emit: vi.fn() },
  useAddEventListener: vi.fn(),
}));

vi.mock('@/renderer/components/chat/BtwOverlay', () => ({ default: () => null }));
vi.mock('@/renderer/components/chat/SpeechInputButton', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/UploadProgressBar', () => ({ default: () => null }));

import SendBox from '@/renderer/components/chat/SendBox';

const SendBoxHarness = ({
  disabled,
  initialValue = '',
  onSend = vi.fn().mockResolvedValue(undefined),
  onAddToDraft,
}: {
  disabled?: boolean;
  initialValue?: string;
  onSend?: (message: string) => Promise<void | false>;
  onAddToDraft?: () => void;
}) => {
  const [value, setValue] = useState(initialValue);
  return <SendBox value={value} onChange={setValue} onSend={onSend} disabled={disabled} onAddToDraft={onAddToDraft} />;
};

describe('SendBox focus', () => {
  it('keeps Enter mapped to Send while Draft box has its own icon action', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onAddToDraft = vi.fn();

    render(<SendBoxHarness initialValue='queued draft' onSend={onSend} onAddToDraft={onAddToDraft} />);
    fireEvent.click(screen.getByTestId('sendbox-add-to-draft-btn'));

    expect(onAddToDraft).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();

    const textarea = screen.getByTestId('sendbox-input');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('queued draft');
  });

  it('restores the input when the parent blocks sending', async () => {
    const onSend = vi.fn().mockResolvedValue(false);

    render(<SendBoxHarness initialValue='blocked message' onSend={onSend} />);

    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('blocked message');
    await waitFor(() => expect(textarea.value).toBe('blocked message'));
  });

  it('uses the platform primary Enter shortcut for Draft box without sending', () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onAddToDraft = vi.fn();

    render(<SendBoxHarness initialValue='save this for later' onSend={onSend} onAddToDraft={onAddToDraft} />);

    const textarea = screen.getByTestId('sendbox-input');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', ctrlKey: true });

    expect(onAddToDraft).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('focuses the textarea on mount (desktop)', async () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it('does not force focus on mobile', async () => {
    layoutState.isMobile = true;
    render(
      <div>
        <button type='button'>outside</button>
        <SendBoxHarness />
      </div>
    );
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    screen.getByRole('button', { name: 'outside' }).focus();
    expect(textarea).not.toHaveFocus();
  });
});

describe('SendBox focus after enable', () => {
  it('focuses once the textarea becomes enabled', async () => {
    layoutState.isMobile = false;
    const { rerender } = render(<SendBoxHarness disabled={true} />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    expect(textarea).not.toHaveFocus();
    rerender(<SendBoxHarness disabled={false} />);
    await waitFor(() => expect(textarea).toHaveFocus());
  });
});
