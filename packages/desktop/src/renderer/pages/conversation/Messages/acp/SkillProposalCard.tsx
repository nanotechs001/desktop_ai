/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input, Tag } from '@arco-design/web-react';
import { Lightning } from '@icon-park/react';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { SKILL_PROPOSAL_LIMITS, type SaveSkillResult, type SkillProposal } from '@/common/types/agent/skillProposal';

export type SkillProposalCardProps = SkillProposal & { conversationId?: string };

type SkillFailure = Extract<SaveSkillResult, { ok: false }>;

const SKILLS_KEY = 'skills.list';

const note = (text: string, action?: React.ReactNode) => (
  <>
    <div className='text-13px text-t-primary break-words'>{text}</div>
    {action}
  </>
);

/** The first `<base>-N` (N >= 2) not in `taken`; the base is trimmed so the name stays within the length limit and valid. */
const freeSkillName = (base: string, taken: Set<string>): string => {
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, SKILL_PROPOSAL_LIMITS.nameMax - suffix.length).replace(/-+$/, '') + suffix;
    if (!taken.has(candidate)) return candidate;
  }
};

/**
 * Review card for a skill the agent proposed: the user can edit the steps, then save it to the skills library (and
 * the chat's bot) or dismiss it. Nothing is saved until they click Save.
 */
const SkillProposalCard: React.FC<SkillProposalCardProps> = ({ name, description, steps, conversationId }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Same key as the skills settings pages, so the list is shared and refreshed together.
  const { data: skills, mutate } = useSWR(SKILLS_KEY, () => ipcBridge.fs.listAvailableSkills.invoke());
  const [draft, setDraft] = useState(steps);
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // The name the last save reported as already taken.
  const [clashName, setClashName] = useState(name);
  const [result, setResult] = useState<SaveSkillResult | undefined>();
  // State updates land after the next render, so two clicks in one tick would both pass a `saving` check.
  const inFlight = useRef(false);

  const save = async (skillName: string) => {
    if (inFlight.current || !conversationId) return;
    inFlight.current = true;
    setSaving(true);
    // Drop the previous outcome so its text never describes the save that is now running.
    setResult(undefined);
    try {
      const saved = await ipcBridge.agentSkills.save.invoke({
        conversation_id: conversationId,
        name: skillName,
        description,
        steps: draft,
      });
      if (saved.ok === false && saved.code === 'exists') setClashName(skillName);
      setResult(saved);
    } catch (error) {
      setResult({ ok: false, code: 'import_failed', message: error instanceof Error ? error.message : String(error) });
    } finally {
      inFlight.current = false;
      setSaving(false);
      void mutate();
    }
  };

  const failureReason = (failure: SkillFailure): string => {
    if (failure.code === 'rate_limited') return t('messages.skillCard.errorRateLimited');
    if (failure.code === 'no_agent') return t('messages.skillCard.errorNoAgent');
    return failure.message;
  };

  const header = (
    <div className='flex items-center gap-8px min-w-0'>
      <Lightning theme='outline' size='14' className='flex-shrink-0 text-t-secondary' />
      <span className='font-medium text-13px text-t-primary'>{t('messages.skillCard.title')}</span>
      <Tag size='small'>{name}</Tag>
    </div>
  );

  const freeName = freeSkillName(name, new Set([...(skills ?? []).map((skill) => skill.name), clashName]));

  const body = (): React.ReactNode => {
    if (dismissed) return <div className='text-13px text-t-secondary'>{t('messages.skillCard.notSaved')}</div>;

    if (result?.ok === true) {
      const text =
        result.library_only || (!result.enable_failed && !result.enabled_for)
          ? t('messages.skillCard.savedLibrary')
          : result.enable_failed
            ? t('messages.skillCard.enableFailed')
            : t('messages.skillCard.saved', { bot: result.enabled_for });
      return note(
        text,
        result.agent_id && !result.library_only ? (
          <div>
            <Button
              size='mini'
              type='text'
              className='!px-0'
              onClick={() =>
                navigate('/assistants', { state: { openAssistantEditor: true, openAssistantId: result.agent_id } })
              }
            >
              {t('messages.skillCard.openSettings')}
            </Button>
          </div>
        ) : undefined
      );
    }

    // Compared with `=== false` because this repo has no strictNullChecks, so a plain truthiness check doesn't narrow.
    const failure = result?.ok === false ? result : undefined;
    const exists = failure?.code === 'exists';
    // Only the same name AND description reads as this card's own skill; a same-name skill from elsewhere is a clash.
    if (!result && skills?.some((skill) => skill.name === name && skill.description?.trim() === description.trim())) {
      return note(t('messages.skillCard.savedLibrary'));
    }

    return (
      <>
        {failure && !exists && (
          <div className='text-13px text-danger break-words'>
            {t('messages.skillCard.error', { message: failureReason(failure) })}
          </div>
        )}
        {exists && (
          <div className='text-13px text-t-primary break-words'>
            {t('messages.skillCard.exists', { name: clashName })}
          </div>
        )}
        <div className='text-13px text-t-secondary break-words'>
          {t('messages.skillCard.appliesWhen', { description })}
        </div>
        <Input.TextArea value={draft} onChange={setDraft} autoSize={{ minRows: 3, maxRows: 12 }} disabled={saving} />
        <div className='flex items-center gap-8px'>
          {exists ? (
            <Button
              size='small'
              type='primary'
              loading={saving}
              disabled={!conversationId}
              onClick={() => void save(freeName)}
            >
              {t('messages.skillCard.saveAs', { name: freeName })}
            </Button>
          ) : (
            <Button
              size='small'
              type='primary'
              loading={saving}
              disabled={!conversationId || !draft.trim()}
              onClick={() => void save(name)}
            >
              {t('messages.skillCard.save')}
            </Button>
          )}
          <Button size='small' disabled={saving} onClick={() => setDismissed(true)}>
            {t('messages.skillCard.dismiss')}
          </Button>
        </div>
      </>
    );
  };

  return (
    <div className='flex flex-col gap-8px rounded-8px border bg-1 p-12px max-w-420px' data-testid='skill-proposal-card'>
      {header}
      {body()}
    </div>
  );
};

export default SkillProposalCard;
