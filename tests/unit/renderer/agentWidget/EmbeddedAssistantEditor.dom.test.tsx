/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The bot editor inside a robot's expanded window: the main window's editor, opened on this bot, without Delete.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handleEdit: vi.fn(),
  editVisible: false,
  assistants: [] as Array<{ id: string; name: string; source: string }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue || k }),
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/AssistantEditorSections', () => ({
  default: () => <div data-testid='assistant-editor-sections' />,
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/SkillConfirmModals', () => ({ default: () => null }));
vi.mock('@/renderer/pages/settings/AssistantSettings/editor/useAssistantEditorViewModel', () => ({
  useAssistantEditorViewModel: () => {
    const fn = vi.fn();
    return {
      assistants: h.assistants,
      activeAssistant: h.assistants[0] ?? null,
      message: { success: fn, error: fn, warning: fn },
      messageContext: null,
      editor: { handleEdit: h.handleEdit, editVisible: h.editVisible, setEditVisible: fn },
      editorViewModel: {
        isCreating: false,
        profile: { name: 'Research Bot', setName: fn, description: '', setDescription: fn, avatar: '', setAvatar: fn },
        actions: { save: fn, requestDelete: fn, duplicate: fn },
      },
    };
  },
}));

import { EmbeddedAssistantEditor } from '@/renderer/pages/settings/AssistantSettings/AssistantEditorPage';

const BOT = { id: 'bot-1', name: 'Research Bot', source: 'user' };

afterEach(() => {
  cleanup();
  h.handleEdit.mockReset();
  h.editVisible = false;
  h.assistants = [];
});

describe('EmbeddedAssistantEditor', () => {
  it('opens the editor on the given bot, without Delete', () => {
    h.assistants = [{ id: 'bot-0', name: 'Other', source: 'user' }, BOT];
    h.editVisible = true;
    render(<EmbeddedAssistantEditor assistantId='bot-1' onBack={vi.fn()} />);

    expect(h.handleEdit).toHaveBeenCalledTimes(1);
    expect(h.handleEdit).toHaveBeenCalledWith(BOT);
    expect(screen.getByTestId('btn-save-assistant')).toBeTruthy();
    expect(screen.queryByTestId('btn-delete-assistant')).toBeNull();
  });

  it('waits for the list before opening, and opens only once', () => {
    const view = render(<EmbeddedAssistantEditor assistantId='bot-1' onBack={vi.fn()} />);
    expect(h.handleEdit).not.toHaveBeenCalled();

    h.assistants = [BOT];
    view.rerender(<EmbeddedAssistantEditor assistantId='bot-1' onBack={vi.fn()} />);
    h.editVisible = true;
    view.rerender(<EmbeddedAssistantEditor assistantId='bot-1' onBack={vi.fn()} />);
    expect(h.handleEdit).toHaveBeenCalledTimes(1);
  });

  it('goes back when cancelled, and when a save closes the editor', () => {
    h.assistants = [BOT];
    h.editVisible = true;
    const onBack = vi.fn();
    const view = render(<EmbeddedAssistantEditor assistantId='bot-1' onBack={onBack} />);
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('btn-cancel-assistant-editor'));
    expect(onBack).toHaveBeenCalledTimes(1);

    h.editVisible = false; // what a successful save does
    act(() => view.rerender(<EmbeddedAssistantEditor assistantId='bot-1' onBack={onBack} />));
    expect(onBack).toHaveBeenCalledTimes(2);
  });
});
