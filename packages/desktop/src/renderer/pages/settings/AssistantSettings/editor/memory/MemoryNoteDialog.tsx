/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import {
  MEMORY_LIMITS,
  MEMORY_NOTE_TYPES,
  type MemoryNote,
  type MemoryNoteType,
  type MemoryVaultRef,
} from '@/common/types/agent/memory';
import { Button, Input, InputTag, Modal, Select, Spin } from '@arco-design/web-react';
import type { Message } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { memoryErrorKey, memoryTypeKey } from './memoryLabels';

export type MemoryDialogTarget = { mode: 'create'; type: MemoryNoteType } | { mode: 'edit'; id: string };

type Draft = { type: MemoryNoteType; title: string; summary: string; body: string; tags: string[] };

type MemoryNoteDialogProps = {
  vault: MemoryVaultRef;
  shared: boolean;
  target: MemoryDialogTarget | null;
  message: ReturnType<typeof Message.useMessage>[0];
  onClose: () => void;
  /** A note created, updated or confirmed. */
  onSaved: (note: MemoryNote) => void;
  onRetired: (id: string) => void;
  /** A write was refused with this code (`stale`: the note changed since it was read); undefined when the call failed. */
  onWriteFailed: (code: string | undefined) => void;
  onPin: (note: MemoryNote) => void;
};

const toDraft = (note: MemoryNote): Draft => ({
  type: note.type,
  title: note.title,
  summary: note.summary,
  body: note.body,
  tags: note.tags,
});

/** One note: create or edit it, retire it, pin it to the core, or (shared, written by an agent) confirm it. */
const MemoryNoteDialog: React.FC<MemoryNoteDialogProps> = (props) => {
  const { vault, shared, target, message, onClose, onSaved, onRetired, onWriteFailed, onPin } = props;
  const { t } = useTranslation();
  const [note, setNote] = useState<MemoryNote | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setNote(null);
    setDraft(null);
    if (!target) return;
    if (target.mode === 'create') {
      setDraft({ type: target.type, title: '', summary: '', body: '', tags: [] });
      return;
    }
    let live = true;
    void ipcBridge.agentMemory.get
      .invoke({ vault, id: target.id })
      .catch((): null => null)
      .then((reply) => {
        if (!live) return;
        if (!reply?.success || !reply.data) {
          message.error(t('agent.memory.loadNoteFailed'));
          onClose();
          return;
        }
        setNote(reply.data);
        setDraft(toDraft(reply.data));
      });
    return () => {
      live = false;
    };
    // The callbacks change identity on every render; only a new target or vault reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, vault]);

  const patch = (change: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...change } : prev));
  const canSave = Boolean(draft?.title.trim() && draft.summary.trim()) && !busy;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const handleSave = (): Promise<void> =>
    run(async () => {
      if (!draft) return;
      const fields = { ...draft, title: draft.title.trim(), summary: draft.summary.trim() };
      const reply = note
        ? await ipcBridge.agentMemory.update
            .invoke({ vault, id: note.id, patch: fields, version: note.version })
            .catch((): null => null)
        : await ipcBridge.agentMemory.create.invoke({ vault, input: fields }).catch((): null => null);
      if (reply?.success && reply.data) onSaved(reply.data);
      else onWriteFailed(reply?.msg);
    });

  const handleConfirm = (): Promise<void> =>
    run(async () => {
      if (!note) return;
      const reply = await ipcBridge.agentMemory.confirm
        .invoke({ vault, id: note.id, version: note.version })
        .catch((): null => null);
      if (!reply?.success || !reply.data) {
        onWriteFailed(reply?.msg);
        return;
      }
      message.success(t('agent.memory.confirmed'));
      onSaved(reply.data);
    });

  const handleRetire = () => {
    if (!note) return;
    Modal.confirm({
      title: t('agent.memory.retire'),
      content: t('agent.memory.retireConfirm'),
      okText: t('agent.memory.retire'),
      cancelText: t('common.cancel'),
      okButtonProps: { status: 'danger' },
      onOk: () =>
        run(async () => {
          const reply = await ipcBridge.agentMemory.retire
            .invoke({ vault, id: note.id, reason: 'Retired by the user in the Memory panel' })
            .catch((): null => null);
          if (reply?.success) onRetired(note.id);
          else message.error(t(memoryErrorKey(reply?.msg, 'agent.memory.retireFailed')));
        }),
    });
  };

  const footer = (
    <div className='flex flex-wrap items-center gap-8px'>
      {note ? (
        <>
          <Button status='danger' disabled={busy} onClick={handleRetire}>
            {t('agent.memory.retire')}
          </Button>
          <Button disabled={busy} onClick={() => onPin(note)}>
            {t('agent.memory.pin')}
          </Button>
          {shared && note.source !== 'user' ? (
            <Button disabled={busy} onClick={() => void handleConfirm()}>
              {t('agent.memory.confirm')}
            </Button>
          ) : null}
        </>
      ) : null}
      <div className='ms-auto flex gap-8px'>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button type='primary' disabled={!canSave} loading={busy} onClick={() => void handleSave()}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal
      visible={target !== null}
      title={t(target?.mode === 'create' ? 'agent.memory.dialog.newTitle' : 'agent.memory.dialog.editTitle')}
      footer={footer}
      onCancel={onClose}
      unmountOnExit
    >
      {!draft ? (
        <div className='flex justify-center py-24px'>
          <Spin />
        </div>
      ) : (
        <div className='flex flex-col gap-12px' data-testid='memory-note-dialog'>
          {shared && note && note.source !== 'user' ? (
            <div className='text-12px leading-18px text-t-tertiary'>{t('agent.memory.confirmHint')}</div>
          ) : null}
          <label className='flex flex-col gap-4px text-12px text-t-secondary'>
            {t('agent.memory.dialog.type')}
            <Select value={draft.type} onChange={(type: MemoryNoteType) => patch({ type })}>
              {MEMORY_NOTE_TYPES.map((type) => (
                <Select.Option key={type} value={type}>
                  {t(memoryTypeKey(type))}
                </Select.Option>
              ))}
            </Select>
          </label>
          <label className='flex flex-col gap-4px text-12px text-t-secondary'>
            {t('agent.memory.dialog.title')}
            <Input
              value={draft.title}
              onChange={(title) => patch({ title })}
              maxLength={MEMORY_LIMITS.maxTitleChars}
              data-testid='memory-note-title'
            />
          </label>
          <label className='flex flex-col gap-4px text-12px text-t-secondary'>
            {t('agent.memory.dialog.summary')}
            <Input.TextArea
              value={draft.summary}
              onChange={(summary) => patch({ summary })}
              maxLength={MEMORY_LIMITS.maxSummaryChars}
              autoSize={{ minRows: 2, maxRows: 4 }}
              data-testid='memory-note-summary'
            />
          </label>
          <label className='flex flex-col gap-4px text-12px text-t-secondary'>
            {t('agent.memory.dialog.body')}
            <Input.TextArea
              value={draft.body}
              onChange={(body) => patch({ body })}
              autoSize={{ minRows: 3, maxRows: 12 }}
              data-testid='memory-note-body'
            />
          </label>
          <label className='flex flex-col gap-4px text-12px text-t-secondary'>
            {t('agent.memory.dialog.tags')}
            <InputTag
              value={draft.tags}
              onChange={(tags: string[]) => patch({ tags: tags.slice(0, MEMORY_LIMITS.maxTags) })}
              validate={(tag: string) => tag.trim().length > 0 && tag.length <= MEMORY_LIMITS.maxTagChars}
              placeholder={t('agent.memory.dialog.tagsPlaceholder')}
              saveOnBlur
              allowClear
            />
          </label>
        </div>
      )}
    </Modal>
  );
};

export default MemoryNoteDialog;
