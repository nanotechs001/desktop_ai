/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type {
  MemoryHygieneIssue,
  MemoryHygieneReport,
  MemoryNoteMeta,
  MemoryVaultRef,
} from '@/common/types/agent/memory';
import { Button, Modal, Tag } from '@arco-design/web-react';
import type { Message } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { memoryErrorKey } from './memoryLabels';
import TidyMemoryButton from './TidyMemoryButton';

type MemoryHealthProps = {
  vault: MemoryVaultRef;
  /** The vault's notes as listed (null while loading): the check runs again whenever they are read again. */
  notes: MemoryNoteMeta[] | null;
  message: ReturnType<typeof Message.useMessage>[0];
  onOpen: (id: string) => void;
  /** A note was changed here: read the vault again. */
  onChanged: () => void;
};

type Duplicate = Extract<MemoryHygieneIssue, { kind: 'duplicate' }>;
type DuplicateNote = Duplicate['notes'][number];

const IssueRow: React.FC<{ title: string; extra?: React.ReactNode; children: React.ReactNode }> = (props) => (
  <div className='flex flex-wrap items-center gap-8px min-w-0' data-testid='memory-health-issue'>
    <span className='min-w-0 flex-1 truncate text-13px text-t-primary'>{props.title}</span>
    {props.extra}
    <div className='flex gap-4px'>{props.children}</div>
  </div>
);

const IssueGroup: React.FC<{ title: string; hint: string; children: React.ReactNode }> = (props) => (
  <div className='flex flex-col gap-6px'>
    <div className='text-12px font-500 text-t-secondary'>{props.title}</div>
    <div className='text-12px leading-18px text-t-tertiary'>{props.hint}</div>
    {props.children}
  </div>
);

/** How full the vault is and what needs tidying (duplicates, links to missing notes, stale facts), with fixes. */
const MemoryHealth: React.FC<MemoryHealthProps> = ({ vault, notes, message, onOpen, onChanged }) => {
  const { t } = useTranslation();
  const [report, setReport] = useState<MemoryHygieneReport | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a fix here, so the check runs again even when the list reads back unchanged.
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (notes === null) return;
    let live = true;
    void ipcBridge.agentMemory.hygiene
      .invoke({ vault })
      .catch((): null => null)
      .then((reply) => {
        if (!live) return;
        const ok = Boolean(reply?.success && reply.data);
        setReport(ok ? (reply?.data ?? null) : null);
        setErrorKey(ok ? null : memoryErrorKey(reply?.msg, 'agent.memory.health.loadFailed'));
      });
    return () => {
      live = false;
    };
  }, [vault, notes, round]);

  /** Runs a write, reports a refusal by its code, and reads the vault again either way. */
  const write = async (action: () => Promise<{ success: boolean; msg?: string } | null>, fallback: string) => {
    setBusy(true);
    const reply = await action().catch((): null => null);
    setBusy(false);
    if (!reply?.success) message.error(t(memoryErrorKey(reply?.msg, fallback)));
    setRound((n) => n + 1);
    onChanged();
  };

  const retireDuplicate = (note: DuplicateNote, newest: DuplicateNote) => {
    Modal.confirm({
      title: t('agent.memory.retire'),
      content: t('agent.memory.health.retireDuplicateConfirm'),
      okText: t('agent.memory.retire'),
      cancelText: t('common.cancel'),
      okButtonProps: { status: 'danger' },
      onOk: () =>
        write(
          () => ipcBridge.agentMemory.retire.invoke({ vault, id: note.id, reason: `Duplicate of ${newest.title}` }),
          'agent.memory.retireFailed'
        ),
    });
  };

  /** "Still true": an empty update with the version as listed only refreshes `updated`. */
  const markStillTrue = (id: string) => {
    const version = notes?.find((note) => note.id === id)?.version;
    void write(
      async () =>
        version
          ? ipcBridge.agentMemory.update.invoke({ vault, id, patch: {}, version })
          : { success: false, msg: 'not-found' },
      'agent.memory.saveFailed'
    );
  };

  const openButton = (id: string) => (
    <Button size='mini' type='text' onClick={() => onOpen(id)}>
      {t('agent.memory.health.open')}
    </Button>
  );

  const issues = report?.issues ?? [];
  const duplicates = issues.filter((issue): issue is Duplicate => issue.kind === 'duplicate');
  const orphans = issues.filter((issue) => issue.kind === 'orphan-link');
  const stale = issues.filter((issue) => issue.kind === 'stale');

  return (
    <div
      className='flex flex-col gap-10px rounded-8px border border-solid border-b-base p-12px'
      data-testid='memory-health'
    >
      <div className='flex flex-wrap items-center gap-8px'>
        <span className='text-13px font-500 text-t-primary'>{t('agent.memory.health.title')}</span>
        {report ? (
          <>
            <Tag size='small'>{t('agent.memory.health.count', { notes: report.notes, max: report.maxNotes })}</Tag>
            <Tag size='small'>{t('agent.memory.health.trash', { trash: report.trash })}</Tag>
          </>
        ) : null}
      </div>
      <TidyMemoryButton vault={vault} />
      {errorKey ? <div className='text-12px text-t-secondary'>{t(errorKey)}</div> : null}
      {report && issues.length === 0 ? (
        <div className='text-12px text-t-secondary'>{t('agent.memory.health.allClear')}</div>
      ) : null}
      {duplicates.length > 0 ? (
        <IssueGroup title={t('agent.memory.health.duplicates')} hint={t('agent.memory.health.duplicatesHint')}>
          {duplicates.map((issue) => (
            <div key={issue.notes.map((note) => note.id).join('|')} className='rounded-6px bg-fill-1 px-8px py-4px'>
              {issue.notes.map((note, index) => (
                <IssueRow key={note.id} title={note.title}>
                  {openButton(note.id)}
                  {index > 0 ? (
                    <Button
                      size='mini'
                      type='text'
                      status='danger'
                      disabled={busy}
                      onClick={() => retireDuplicate(note, issue.notes[0])}
                    >
                      {t('agent.memory.retire')}
                    </Button>
                  ) : null}
                </IssueRow>
              ))}
            </div>
          ))}
        </IssueGroup>
      ) : null}
      {orphans.length > 0 ? (
        <IssueGroup title={t('agent.memory.health.orphanLinks')} hint={t('agent.memory.health.orphanLinksHint')}>
          {orphans.map((issue) => (
            <IssueRow
              key={`${issue.id}|${issue.link}`}
              title={issue.title}
              extra={
                <Tag size='small' color='orange'>
                  {issue.link}
                </Tag>
              }
            >
              {openButton(issue.id)}
            </IssueRow>
          ))}
        </IssueGroup>
      ) : null}
      {stale.length > 0 && report ? (
        <IssueGroup
          title={t('agent.memory.health.stale')}
          hint={t('agent.memory.health.staleHint', { days: report.staleAfterDays })}
        >
          {stale.map((issue) => (
            <IssueRow key={issue.id} title={issue.title}>
              {openButton(issue.id)}
              <Button size='mini' type='text' disabled={busy} onClick={() => markStillTrue(issue.id)}>
                {t('agent.memory.health.stillTrue')}
              </Button>
            </IssueRow>
          ))}
        </IssueGroup>
      ) : null}
    </div>
  );
};

export default MemoryHealth;
