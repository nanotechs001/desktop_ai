import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '@/common/types/agent/artifacts';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentNotes: {
      list: { invoke: mocks.list },
      add: { invoke: mocks.add },
      update: { invoke: mocks.update },
      delete: { invoke: mocks.remove },
    },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

import AgentNotebook from '@/renderer/pages/settings/AssistantSettings/editor/AgentNotebook';

const notes: Note[] = [
  { id: 'old'.padEnd(22, 'x'), text: 'Prefers short answers', source: 'agent', at: 1 },
  { id: 'new'.padEnd(22, 'x'), text: 'Checkout needs a login', source: 'page', at: 3 },
  { id: 'mid'.padEnd(22, 'x'), text: 'Answer in French', source: 'user', at: 2 },
];

beforeEach(() => {
  mocks.list.mockReset().mockResolvedValue({ success: true, data: notes });
  mocks.add.mockReset();
  mocks.update.mockReset();
  mocks.remove.mockReset().mockResolvedValue({ success: true });
});

const rows = () => screen.getAllByTestId('agent-note');

describe('AgentNotebook', () => {
  it('the notebook UI lists, edits and deletes notes and adds a user instruction', async () => {
    render(<AgentNotebook agentId='agent-1' />);

    // Newest first, each marked with where it came from.
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(mocks.list).toHaveBeenCalledWith({ agentId: 'agent-1' });
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Checkout needs a login'),
      expect.stringContaining('Answer in French'),
      expect.stringContaining('Prefers short answers'),
    ]);
    expect(within(rows()[0]).getByText('From a web page')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('Instruction')).toBeInTheDocument();
    expect(within(rows()[2]).getByText('Learned')).toBeInTheDocument();

    // Edit
    mocks.update.mockResolvedValue({ success: true, data: { ...notes[0], text: 'Prefers bullet lists' } });
    fireEvent.click(within(rows()[2]).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByTestId('agent-note-edit-input'), { target: { value: 'Prefers bullet lists' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({ agentId: 'agent-1', id: notes[0].id, text: 'Prefers bullet lists' })
    );
    await waitFor(() => expect(screen.getByText('Prefers bullet lists')).toBeInTheDocument());

    // Delete
    fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith({ agentId: 'agent-1', id: notes[1].id }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByText('Checkout needs a login')).not.toBeInTheDocument();

    // Add instruction
    mocks.add.mockResolvedValue({
      success: true,
      data: { id: 'add'.padEnd(22, 'x'), text: 'Use metric units', source: 'user', at: 9 },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add instruction' }));
    fireEvent.change(screen.getByTestId('agent-note-new-input'), { target: { value: 'Use metric units' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith({ agentId: 'agent-1', text: 'Use metric units' }));
    await waitFor(() => expect(rows()[0].textContent).toContain('Use metric units'));
    expect(within(rows()[0]).getByText('Instruction')).toBeInTheDocument();
  });

  it('shows the empty state, and keeps a note whose delete failed', async () => {
    mocks.list.mockResolvedValueOnce({ success: true, data: [] });
    const { unmount } = render(<AgentNotebook agentId='agent-1' />);
    await waitFor(() => expect(screen.getByText('No notes yet.')).toBeInTheDocument());
    unmount();

    mocks.remove.mockResolvedValue({ success: false, msg: 'disk full' });
    render(<AgentNotebook agentId='agent-1' />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(rows()[0]).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalled());
    expect(rows()).toHaveLength(3);
  });
});
