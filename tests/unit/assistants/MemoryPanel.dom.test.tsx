/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
// The app loads this in main.tsx; Modal.confirm cannot render under React 19 without it.
import '@arco-design/web-react/lib/_util/react-19-adapter';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemoryHygieneReport, MemoryNote, MemoryNoteMeta } from '@/common/types/agent/memory';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  retire: vi.fn(),
  confirm: vi.fn(),
  getCore: vi.fn(),
  setCore: vi.fn(),
  openFolder: vi.fn(),
  hygiene: vi.fn(),
  navigate: vi.fn(),
  config: {} as Record<string, string | undefined>,
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  desktop: true,
}));
const { invoker } = vi.hoisted(() => ({
  invoker: (fn: (...args: unknown[]) => unknown) => ({ invoke: (...args: unknown[]) => fn(...args) }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentMemory: {
      list: invoker(mocks.list),
      get: invoker(mocks.get),
      create: invoker(mocks.create),
      update: invoker(mocks.update),
      retire: invoker(mocks.retire),
      confirm: invoker(mocks.confirm),
      getCore: invoker(mocks.getCore),
      setCore: invoker(mocks.setCore),
      openFolder: invoker(mocks.openFolder),
      hygiene: invoker(mocks.hygiene),
    },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => mocks.desktop }));
vi.mock('@/common/config/configService', () => ({ configService: { get: (key: string) => mocks.config[key] } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
// Interpolated values are appended, so a test can see them: `key:1,2`.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join(',')}` : key),
  }),
}));
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const arco = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...arco, Message: { ...arco.Message, useMessage: () => [mocks.message, null] } };
});

import MemoryPanel from '@/renderer/pages/settings/AssistantSettings/editor/memory/MemoryPanel';
import { filterMemoryNotes, pinToCore } from '@/renderer/pages/settings/AssistantSettings/editor/memory/memoryLabels';

const meta = (id: string, extra: Partial<MemoryNoteMeta> = {}): MemoryNoteMeta => ({
  id,
  type: 'fact',
  title: `Title ${id}`,
  summary: `Summary ${id}`,
  tags: [],
  source: 'agent',
  confidence: 'high',
  status: 'active',
  created: '2026-10-01T00:00:00Z',
  updated: '2026-10-01T00:00:00Z',
  fromChats: [],
  version: `v-${id}`,
  ...extra,
});
const full = (note: MemoryNoteMeta, body = 'Body'): MemoryNote => ({ ...note, body });

const AGENT_NOTES = [
  meta('old', { title: 'Launch date', summary: 'Moved to November', updated: '2026-10-01T00:00:00Z' }),
  meta('new', { type: 'instructions', title: 'Reply in French', source: 'user', updated: '2026-10-20T00:00:00Z' }),
  meta('page', { type: 'source', title: 'Pricing page', source: 'page', status: 'superseded', tags: ['client'] }),
];
const SHARED_NOTES = [meta('s1', { type: 'preference', title: 'Likes tea', source: 'agent' })];

const ok = <T,>(data: T) => ({ success: true, data });
const report = (extra: Partial<MemoryHygieneReport> = {}): MemoryHygieneReport => ({
  notes: 3,
  maxNotes: 2000,
  trash: 1,
  staleAfterDays: 180,
  issues: [],
  ...extra,
});
const health = () => screen.getByTestId('memory-health');
const rows = () => screen.getAllByTestId('memory-note');
const noteDialog = () => screen.getByTestId('memory-note-dialog').closest('.arco-modal') as HTMLElement;
const vaultOf = (call: unknown[]) => (call[0] as { vault: unknown }).vault;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = true;
  mocks.list.mockImplementation(async ({ vault }: { vault: { kind: string } }) =>
    ok(vault.kind === 'shared' ? SHARED_NOTES : AGENT_NOTES)
  );
  mocks.getCore.mockResolvedValue(ok('- Lives in Lisbon'));
  mocks.setCore.mockResolvedValue({ success: true });
  mocks.get.mockImplementation(async ({ id }: { id: string }) =>
    ok(full([...AGENT_NOTES, ...SHARED_NOTES].find((n) => n.id === id)!))
  );
  mocks.openFolder.mockResolvedValue({ success: true });
  mocks.hygiene.mockResolvedValue(ok(report()));
  mocks.config = {};
});

const openNote = async (title: string) => {
  fireEvent.click(await screen.findByText(title));
  return screen.findByTestId('memory-note-dialog');
};

describe('MemoryPanel', () => {
  it("lists this agent's notes newest first, with type, who wrote it and replaced notes marked", async () => {
    render(<MemoryPanel agentId='agent-1' />);

    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(vaultOf(mocks.list.mock.calls[0])).toEqual({ kind: 'agent', agentId: 'agent-1' });
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Reply in French'),
      expect.stringContaining('Launch date'),
      expect.stringContaining('Pricing page'),
    ]);
    expect(within(rows()[0]).getByText('agent.memory.types.instructions')).toBeInTheDocument();
    expect(within(rows()[0]).getByText('agent.memory.source.user')).toBeInTheDocument();
    expect(within(rows()[1]).getByText('agent.memory.source.agent')).toBeInTheDocument();
    expect(within(rows()[2]).getByText('agent.memory.source.page')).toBeInTheDocument();
    expect(within(rows()[2]).getByText('agent.memory.superseded')).toBeInTheDocument();
    expect(rows()[2].className).toContain('opacity-60');
    expect(screen.getByTestId('memory-core-input')).toHaveValue('- Lives in Lisbon');
  });

  it('filters the notes by the search text', async () => {
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.change(screen.getByPlaceholderText('agent.memory.search'), {
      target: { value: 'november' },
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent('Launch date');

    fireEvent.change(screen.getByPlaceholderText('agent.memory.search'), {
      target: { value: 'nothing like it' },
    });
    expect(screen.getByText('agent.memory.noMatch')).toBeInTheDocument();
  });

  it('saves the pinned facts', async () => {
    render(<MemoryPanel agentId='agent-1' />);
    const core = await screen.findByTestId('memory-core-input');
    await waitFor(() => expect(core).toHaveValue('- Lives in Lisbon'));

    fireEvent.change(core, { target: { value: '- Lives in Porto' } });
    fireEvent.click(within(screen.getByTestId('memory-core')).getByRole('button', { name: 'common.save' }));

    await waitFor(() =>
      expect(mocks.setCore).toHaveBeenCalledWith({
        vault: { kind: 'agent', agentId: 'agent-1' },
        text: '- Lives in Porto',
      })
    );
  });

  it('edits a note, sending the version it read', async () => {
    mocks.update.mockImplementation(async ({ patch }: { patch: Partial<MemoryNote> }) =>
      ok(full({ ...AGENT_NOTES[0], ...patch, version: 'v2' } as MemoryNoteMeta))
    );
    render(<MemoryPanel agentId='agent-1' />);
    await openNote('Launch date');

    fireEvent.change(screen.getByTestId('memory-note-title'), { target: { value: 'Launch moved' } });
    fireEvent.click(within(noteDialog()).getByRole('button', { name: 'common.save' }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        vault: { kind: 'agent', agentId: 'agent-1' },
        id: 'old',
        version: 'v-old',
        patch: { type: 'fact', title: 'Launch moved', summary: 'Moved to November', body: 'Body', tags: [] },
      })
    );
    await screen.findByText('Launch moved');
  });

  it('says so and shows the latest when the note changed since it was opened', async () => {
    mocks.update.mockResolvedValue({ success: false, msg: 'stale' });
    render(<MemoryPanel agentId='agent-1' />);
    await openNote('Launch date');
    mocks.list.mockResolvedValue(ok([{ ...AGENT_NOTES[0], title: 'Launch (edited in Obsidian)', version: 'v9' }]));

    fireEvent.click(within(noteDialog()).getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(mocks.message.warning).toHaveBeenCalledWith('agent.memory.errors.stale'));
    await screen.findByText('Launch (edited in Obsidian)');
  });

  it('keeps the dialog open and reports an error when a save fails for another reason', async () => {
    mocks.update.mockResolvedValue({ success: false, msg: 'invalid' });
    render(<MemoryPanel agentId='agent-1' />);
    await openNote('Launch date');

    fireEvent.click(within(noteDialog()).getByRole('button', { name: 'common.save' }));

    await waitFor(() => expect(mocks.message.error).toHaveBeenCalledWith('agent.memory.errors.invalid'));
    expect(screen.getByTestId('memory-note-dialog')).toBeInTheDocument();
  });

  it('explains a refused write by its code, with a fallback for a failed call', async () => {
    mocks.create.mockResolvedValueOnce({ success: false, msg: 'limit-reached' }).mockRejectedValueOnce(new Error('x'));
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'agent.memory.addNote' }));
    await screen.findByTestId('memory-note-dialog');
    fireEvent.change(screen.getByTestId('memory-note-title'), { target: { value: 'T' } });
    fireEvent.change(screen.getByTestId('memory-note-summary'), { target: { value: 'S' } });

    fireEvent.click(within(noteDialog()).getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.message.error).toHaveBeenCalledWith('agent.memory.errors.limitReached'));
    fireEvent.click(within(noteDialog()).getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(mocks.message.error).toHaveBeenCalledWith('agent.memory.saveFailed'));
  });

  it('retires a note after confirming', async () => {
    mocks.retire.mockResolvedValue({ success: true });
    render(<MemoryPanel agentId='agent-1' />);
    await openNote('Launch date');

    fireEvent.click(within(noteDialog()).getByRole('button', { name: 'agent.memory.retire' }));
    expect(mocks.retire).not.toHaveBeenCalled();
    const confirm = await screen.findByText('agent.memory.retireConfirm');
    const confirmModal = confirm.closest('.arco-modal') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(confirmModal).getByRole('button', { name: 'agent.memory.retire' }));
    });

    await waitFor(() =>
      expect(mocks.retire).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'old', vault: { kind: 'agent', agentId: 'agent-1' } })
      )
    );
    await waitFor(() => expect(screen.queryByText('Launch date')).not.toBeInTheDocument());
  });

  it('pins a note to the core', async () => {
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(screen.getByTestId('memory-core-input')).toHaveValue('- Lives in Lisbon'));
    await openNote('Launch date');

    fireEvent.click(screen.getByRole('button', { name: 'agent.memory.pin' }));

    await waitFor(() =>
      expect(mocks.setCore).toHaveBeenCalledWith({
        vault: { kind: 'agent', agentId: 'agent-1' },
        text: '- Lives in Lisbon\n- Launch date: Moved to November',
      })
    );
  });

  it('adds a note, an instruction to the agent by default', async () => {
    mocks.create.mockImplementation(async ({ input }: { input: Partial<MemoryNote> }) =>
      ok(full(meta('added', { ...input, source: 'user' })))
    );
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.click(screen.getByRole('button', { name: 'agent.memory.addNote' }));
    await screen.findByTestId('memory-note-dialog');
    const save = within(noteDialog()).getByRole('button', { name: 'common.save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId('memory-note-title'), { target: { value: 'Use metric' } });
    fireEvent.change(screen.getByTestId('memory-note-summary'), { target: { value: 'Always metric units' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        vault: { kind: 'agent', agentId: 'agent-1' },
        input: { type: 'instructions', title: 'Use metric', summary: 'Always metric units', body: '', tags: [] },
      })
    );
    await waitFor(() => expect(rows()).toHaveLength(4));
  });

  it('shows the shared memory about the user, and confirms a note an agent wrote', async () => {
    mocks.confirm.mockResolvedValue(ok(full({ ...SHARED_NOTES[0], source: 'user', version: 'v2' })));
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(rows()).toHaveLength(3));

    fireEvent.click(screen.getByText('agent.memory.tabs.shared'));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(mocks.list).toHaveBeenCalledWith({ vault: { kind: 'shared' } });
    expect(screen.getByText('agent.memory.sharedHint')).toBeInTheDocument();
    expect(within(rows()[0]).getByText('agent.memory.source.sharedAgent')).toBeInTheDocument();

    await openNote('Likes tea');
    fireEvent.click(screen.getByRole('button', { name: 'agent.memory.confirm' }));

    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith({ vault: { kind: 'shared' }, id: 's1', version: 'v-s1' })
    );
    await waitFor(() => expect(within(rows()[0]).getByText('agent.memory.source.user')).toBeInTheDocument());
  });

  it('offers Open folder on the desktop only', async () => {
    const { unmount } = render(<MemoryPanel agentId='agent-1' />);
    fireEvent.click(await screen.findByRole('button', { name: 'agent.memory.openFolder' }));
    await waitFor(() =>
      expect(mocks.openFolder).toHaveBeenCalledWith({ vault: { kind: 'agent', agentId: 'agent-1' } })
    );
    unmount();

    mocks.desktop = false;
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.queryByRole('button', { name: 'agent.memory.openFolder' })).not.toBeInTheDocument();
  });

  it('shows the empty state, and an error with a retry when the memory cannot be read', async () => {
    mocks.list.mockResolvedValueOnce(ok([]));
    const { unmount } = render(<MemoryPanel agentId='agent-1' />);
    await screen.findByText('agent.memory.empty');
    unmount();

    mocks.list.mockRejectedValueOnce(new Error('ipc down'));
    render(<MemoryPanel agentId='agent-1' />);
    await screen.findByText('agent.memory.loadFailed');
    fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it('reads the memory again when the window comes back into view', async () => {
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    mocks.list.mockResolvedValue(ok([meta('fresh', { title: 'Learned in a chat' })]));

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await screen.findByText('Learned in a chat');
  });
});

describe('Memory health', () => {
  it('shows how full the memory is, and an all-clear when nothing needs tidying', async () => {
    render(<MemoryPanel agentId='agent-1' />);

    await screen.findByText('agent.memory.health.count:3,2000');
    expect(mocks.hygiene).toHaveBeenCalledWith({ vault: { kind: 'agent', agentId: 'agent-1' } });
    expect(within(health()).getByText('agent.memory.health.trash:1')).toBeInTheDocument();
    expect(within(health()).getByText('agent.memory.health.allClear')).toBeInTheDocument();
  });

  it('reports a failed check by its code', async () => {
    mocks.hygiene.mockResolvedValueOnce({ success: false, msg: 'io' });
    render(<MemoryPanel agentId='agent-1' />);
    expect(await screen.findByText('agent.memory.errors.io')).toBeInTheDocument();
  });

  it('lists duplicates, opens one, and retires all but the newest after confirming', async () => {
    mocks.hygiene.mockResolvedValue(
      ok(
        report({
          issues: [
            {
              kind: 'duplicate',
              notes: [
                { id: 'new', title: 'Reply in French', updated: '2026-10-20T00:00:00Z' },
                { id: 'old', title: 'Launch date', updated: '2026-10-01T00:00:00Z' },
              ],
            },
          ],
        })
      )
    );
    mocks.retire.mockResolvedValue({ success: true });
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(within(health()).getByText('Launch date')).toBeInTheDocument());
    expect(within(health()).queryByText('agent.memory.health.allClear')).not.toBeInTheDocument();

    const retireButtons = within(health()).getAllByRole('button', { name: 'agent.memory.retire' });
    expect(retireButtons).toHaveLength(1);
    fireEvent.click(retireButtons[0]);
    const confirmModal = (await screen.findByText('agent.memory.health.retireDuplicateConfirm')).closest(
      '.arco-modal'
    ) as HTMLElement;
    const listCalls = mocks.list.mock.calls.length;
    await act(async () => {
      fireEvent.click(within(confirmModal).getByRole('button', { name: 'agent.memory.retire' }));
    });

    await waitFor(() =>
      expect(mocks.retire).toHaveBeenCalledWith({
        vault: { kind: 'agent', agentId: 'agent-1' },
        id: 'old',
        reason: 'Duplicate of Reply in French',
      })
    );
    await waitFor(() => expect(mocks.list.mock.calls.length).toBeGreaterThan(listCalls));

    fireEvent.click(within(health()).getAllByRole('button', { name: 'agent.memory.health.open' })[0]);
    await screen.findByTestId('memory-note-dialog');
    expect(mocks.get).toHaveBeenCalledWith({ vault: { kind: 'agent', agentId: 'agent-1' }, id: 'new' });
  });

  it('reports a duplicate that could not be retired', async () => {
    mocks.hygiene.mockResolvedValue(
      ok(
        report({
          issues: [
            {
              kind: 'duplicate',
              notes: [
                { id: 'new', title: 'A', updated: '2026-10-20T00:00:00Z' },
                { id: 'old', title: 'B', updated: '2026-10-01T00:00:00Z' },
              ],
            },
          ],
        })
      )
    );
    mocks.retire.mockResolvedValue({ success: false, msg: 'forbidden' });
    render(<MemoryPanel agentId='agent-1' />);
    fireEvent.click(
      await within(await screen.findByTestId('memory-health')).findByRole('button', { name: 'agent.memory.retire' })
    );
    const confirmModal = (await screen.findByText('agent.memory.health.retireDuplicateConfirm')).closest(
      '.arco-modal'
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(within(confirmModal).getByRole('button', { name: 'agent.memory.retire' }));
    });
    await waitFor(() => expect(mocks.message.error).toHaveBeenCalledWith('agent.memory.errors.forbidden'));
  });

  it('opens a note that links to a missing note', async () => {
    mocks.hygiene.mockResolvedValue(
      ok(report({ issues: [{ kind: 'orphan-link', id: 'old', title: 'Launch date', link: 'Old plan' }] }))
    );
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(within(health()).getByText('Old plan')).toBeInTheDocument());

    fireEvent.click(within(health()).getByRole('button', { name: 'agent.memory.health.open' }));

    await screen.findByTestId('memory-note-dialog');
    expect(mocks.get).toHaveBeenCalledWith({ vault: { kind: 'agent', agentId: 'agent-1' }, id: 'old' });
  });

  it('marks a stale note as still true with an empty update, then checks again', async () => {
    mocks.hygiene.mockResolvedValue(
      ok(report({ issues: [{ kind: 'stale', id: 'old', title: 'Launch date', updated: '2026-01-01T00:00:00Z' }] }))
    );
    mocks.update.mockResolvedValue(ok(full(AGENT_NOTES[0])));
    render(<MemoryPanel agentId='agent-1' />);
    await waitFor(() => expect(within(health()).getByText('Launch date')).toBeInTheDocument());
    mocks.hygiene.mockResolvedValue(ok(report()));

    fireEvent.click(within(health()).getByRole('button', { name: 'agent.memory.health.stillTrue' }));

    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        vault: { kind: 'agent', agentId: 'agent-1' },
        id: 'old',
        patch: {},
        version: 'v-old',
      })
    );
    await within(health()).findByText('agent.memory.health.allClear');
  });

  it('explains a refused "still true" by its code', async () => {
    mocks.hygiene.mockResolvedValue(
      ok(report({ issues: [{ kind: 'stale', id: 'old', title: 'Launch date', updated: '2026-01-01T00:00:00Z' }] }))
    );
    mocks.update.mockResolvedValue({ success: false, msg: 'stale' });
    render(<MemoryPanel agentId='agent-1' />);
    fireEvent.click(
      await within(await screen.findByTestId('memory-health')).findByRole('button', {
        name: 'agent.memory.health.stillTrue',
      })
    );
    await waitFor(() => expect(mocks.message.error).toHaveBeenCalledWith('agent.memory.errors.stale'));
  });

  it('opens a new chat with this agent and the tidy prompt, without sending it', async () => {
    render(<MemoryPanel agentId='agent-1' />);
    expect(await screen.findByText('agent.memory.tidy.hint')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'agent.memory.tidy.button' }));

    expect(mocks.navigate).toHaveBeenCalledWith('/guid', {
      state: { selectedAssistantId: 'agent-1', prefillPrompt: 'agent.memory.tidy.prompt', focusPrefill: true },
    });
  });

  it('tidies the shared memory with the main agent', async () => {
    mocks.config = { 'agent.builtinDefaultId': 'main-agent' };
    render(<MemoryPanel agentId='agent-1' />);
    fireEvent.click(await screen.findByText('agent.memory.tabs.shared'));
    await waitFor(() => expect(mocks.hygiene).toHaveBeenCalledWith({ vault: { kind: 'shared' } }));

    fireEvent.click(await screen.findByRole('button', { name: 'agent.memory.tidy.button' }));

    expect(mocks.navigate).toHaveBeenCalledWith('/guid', {
      state: { selectedAssistantId: 'main-agent', prefillPrompt: 'agent.memory.tidy.promptShared', focusPrefill: true },
    });
  });
});

describe('memory helpers', () => {
  it('filters by type and by title, summary or tag', () => {
    expect(filterMemoryNotes(AGENT_NOTES, '', 'instructions').map((n) => n.id)).toEqual(['new']);
    expect(filterMemoryNotes(AGENT_NOTES, 'CLIENT', 'all').map((n) => n.id)).toEqual(['page']);
    expect(filterMemoryNotes(AGENT_NOTES, 'client', 'fact')).toEqual([]);
  });

  it('pins a line to an empty or existing core', () => {
    expect(pinToCore('', { title: 'A', summary: 'b' })).toBe('- A: b');
    expect(pinToCore('- X\n\n', { title: 'A', summary: '' })).toBe('- X\n- A');
  });
});
