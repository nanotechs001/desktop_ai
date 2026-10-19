/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { SKILL_NAME_RE, type SaveSkillResult } from '@/common/types/agent/skillProposal';

const mocks = vi.hoisted(() => ({ save: vi.fn(), listSkills: vi.fn(), navigate: vi.fn() }));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentSkills: { save: { invoke: mocks.save } },
    fs: { listAvailableSkills: { invoke: mocks.listSkills } },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options && Object.keys(options).length ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));

import SkillProposalCard from '@/renderer/pages/conversation/Messages/acp/SkillProposalCard';

const proposal = {
  name: 'weekly-report',
  description: 'Use when the user asks for the weekly report',
  steps: '1. Open the dashboard\n2. Export the numbers',
};

const renderCard = (overrides: Partial<typeof proposal> = {}) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SkillProposalCard {...proposal} {...overrides} conversationId='c1' />
    </SWRConfig>
  );

const ok = (extra: Partial<Extract<SaveSkillResult, { ok: true }>> = {}): SaveSkillResult => ({
  ok: true,
  skill_name: 'weekly-report',
  ...extra,
});

describe('SkillProposalCard', () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.listSkills.mockReset().mockResolvedValue([]);
    mocks.navigate.mockReset();
  });

  it('shows the name, when it applies and editable steps', async () => {
    renderCard();

    expect(await screen.findByText('weekly-report')).toBeInTheDocument();
    expect(screen.getByText(/messages\.skillCard\.appliesWhen.*weekly report/)).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(proposal.steps);
  });

  it('Save sends the edited steps with the conversation id', async () => {
    mocks.save.mockResolvedValue(ok());
    renderCard();

    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Just one step' } });
    fireEvent.click(screen.getByText('messages.skillCard.save'));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({ ...proposal, steps: 'Just one step', conversation_id: 'c1' })
    );
  });

  it('shows saved with the bot name and an Open bot settings link after Save', async () => {
    mocks.save.mockResolvedValue(ok({ agent_id: 'bot-1', enabled_for: 'Writer' }));
    renderCard();

    fireEvent.click(await screen.findByText('messages.skillCard.save'));

    expect(await screen.findByText(/messages\.skillCard\.saved .*Writer/)).toBeInTheDocument();
    expect(screen.queryByText('messages.skillCard.save')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('messages.skillCard.openSettings'));
    expect(mocks.navigate).toHaveBeenCalledWith('/assistants', {
      state: { openAssistantEditor: true, openAssistantId: 'bot-1' },
    });
  });

  it('a second click while saving does nothing', async () => {
    mocks.save.mockReturnValue(new Promise(() => {}));
    renderCard();

    const save = await screen.findByText('messages.skillCard.save');
    fireEvent.click(save);
    fireEvent.click(save);

    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it('shows Saved without a Save button when the library already has the name', async () => {
    mocks.listSkills.mockResolvedValue([{ name: 'weekly-report', description: `  ${proposal.description} ` }]);
    renderCard();

    expect(await screen.findByText('messages.skillCard.savedLibrary')).toBeInTheDocument();
    expect(screen.queryByText('messages.skillCard.save')).not.toBeInTheDocument();
  });

  it('on exists offers Save as <name>-2 and saves under that name', async () => {
    mocks.save.mockResolvedValueOnce({ ok: false, code: 'exists', message: 'exists' });
    mocks.save.mockResolvedValueOnce(ok({ skill_name: 'weekly-report-2', enabled_for: 'Writer' }));
    renderCard();

    const save = await screen.findByText('messages.skillCard.save');
    // By the time the save answers, the refreshed library lists the clashing name; that must not read as Saved.
    mocks.listSkills.mockResolvedValue([{ name: 'weekly-report', description: 'something else entirely' }]);
    fireEvent.click(save);

    expect(await screen.findByText(/messages\.skillCard\.exists .*weekly-report/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/messages\.skillCard\.saveAs .*weekly-report-2/));

    await waitFor(() =>
      expect(mocks.save).toHaveBeenLastCalledWith({ ...proposal, name: 'weekly-report-2', conversation_id: 'c1' })
    );
    expect(await screen.findByText(/messages\.skillCard\.saved .*Writer/)).toBeInTheDocument();
  });

  it('does not call a same-name skill with another description Saved: Save, then exists, then Save as', async () => {
    mocks.listSkills.mockResolvedValue([{ name: 'weekly-report', description: 'An unrelated skill of the same name' }]);
    mocks.save.mockResolvedValue({ ok: false, code: 'exists', message: 'exists' });
    renderCard();

    fireEvent.click(await screen.findByText('messages.skillCard.save'));

    expect(await screen.findByText(/messages\.skillCard\.exists .*weekly-report/)).toBeInTheDocument();
    expect(screen.getByText(/messages\.skillCard\.saveAs .*weekly-report-2/)).toBeInTheDocument();
  });

  it('while Save as is running, shows neither the exists text for the new name nor a -2-2 label', async () => {
    mocks.listSkills.mockResolvedValue([{ name: 'weekly-report', description: 'An unrelated skill of the same name' }]);
    mocks.save.mockResolvedValueOnce({ ok: false, code: 'exists', message: 'exists' });
    mocks.save.mockReturnValueOnce(new Promise(() => {}));
    renderCard();

    fireEvent.click(await screen.findByText('messages.skillCard.save'));
    fireEvent.click(await screen.findByText(/messages\.skillCard\.saveAs .*weekly-report-2/));

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/messages\.skillCard\.exists/)).not.toBeInTheDocument();
    expect(screen.queryByText(/weekly-report-2-2/)).not.toBeInTheDocument();
  });

  it('offers the first free <name>-N', async () => {
    mocks.listSkills.mockResolvedValue([
      { name: 'weekly-report', description: 'other' },
      { name: 'weekly-report-2', description: 'other' },
    ]);
    mocks.save.mockResolvedValue({ ok: false, code: 'exists', message: 'exists' });
    renderCard();

    fireEvent.click(await screen.findByText('messages.skillCard.save'));

    expect(await screen.findByText(/messages\.skillCard\.saveAs .*weekly-report-3/)).toBeInTheDocument();
  });

  it.each([
    ['a'.repeat(47) + 'b', 'a'.repeat(46) + '-2'],
    ['a'.repeat(45) + '-bb', 'a'.repeat(45) + '-2'],
  ])('trims the %s base so the offered name stays valid and within 48 characters', async (name, expected) => {
    expect(name).toHaveLength(48);
    mocks.listSkills.mockResolvedValue([{ name, description: 'other' }]);
    mocks.save.mockResolvedValue({ ok: false, code: 'exists', message: 'exists' });
    renderCard({ name });

    fireEvent.click(await screen.findByText('messages.skillCard.save'));

    const label = await screen.findByText(/messages\.skillCard\.saveAs/);
    const offered = JSON.parse(label.textContent!.replace('messages.skillCard.saveAs ', '')).name as string;
    expect(offered).toBe(expected);
    expect(offered.length).toBeLessThanOrEqual(48);
    expect(offered).toMatch(SKILL_NAME_RE);
  });

  it.each([
    ['rate_limited', 'messages.skillCard.errorRateLimited'],
    ['no_agent', 'messages.skillCard.errorNoAgent'],
    ['import_failed', 'disk full'],
  ] as const)('shows a localized error for %s and keeps Save for a retry', async (code, reason) => {
    mocks.save.mockResolvedValue({ ok: false, code, message: 'disk full' });
    renderCard();

    fireEvent.click(await screen.findByText('messages.skillCard.save'));

    expect(
      await screen.findByText(new RegExp(`messages\\.skillCard\\.error .*${reason.replace(/\./g, '\\.')}`))
    ).toBeInTheDocument();
    expect(screen.getByText('messages.skillCard.save')).toBeInTheDocument();
  });

  it('shows the library-only and enable_failed messages', async () => {
    mocks.save.mockResolvedValueOnce(ok({ library_only: true }));
    const first = renderCard();
    fireEvent.click(await screen.findByText('messages.skillCard.save'));
    expect(await screen.findByText('messages.skillCard.savedLibrary')).toBeInTheDocument();
    first.unmount();

    mocks.save.mockResolvedValueOnce(ok({ enable_failed: true, agent_id: 'bot-1' }));
    renderCard();
    fireEvent.click(await screen.findByText('messages.skillCard.save'));
    expect(await screen.findByText('messages.skillCard.enableFailed')).toBeInTheDocument();
  });

  it('Dismiss collapses to Not saved without calling save', async () => {
    renderCard();

    fireEvent.click(await screen.findByText('messages.skillCard.dismiss'));

    expect(screen.getByText('messages.skillCard.notSaved')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
