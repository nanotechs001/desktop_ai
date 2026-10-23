/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import {
  MEMORY_NOTE_TYPES,
  type MemoryNote,
  type MemoryNoteMeta,
  type MemoryNoteType,
  type MemoryVaultRef,
} from '@/common/types/agent/memory';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { Button, Input, Message, Select } from '@arco-design/web-react';
import { FolderOpen, Plus, Search } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import MemoryCoreEditor from './MemoryCoreEditor';
import MemoryHealth from './MemoryHealth';
import { filterMemoryNotes, MEMORY_CORE_MAX_CHARS, memoryErrorKey, memoryTypeKey, pinToCore } from './memoryLabels';
import MemoryNoteDialog, { type MemoryDialogTarget } from './MemoryNoteDialog';
import MemoryNoteList from './MemoryNoteList';
import { useMemoryVault } from './useMemoryVault';

type MemoryVaultViewProps = {
  vault: MemoryVaultRef;
};

const toMeta = ({ body: _body, ...meta }: MemoryNote): MemoryNoteMeta => meta;

/** One vault in the Memory panel: its core, its notes (search, type filter) and the note dialog. */
const MemoryVaultView: React.FC<MemoryVaultViewProps> = ({ vault }) => {
  const { t } = useTranslation();
  const [messageApi, messageContext] = Message.useMessage();
  const { notes, setNotes, core, setCore, loadFailed, reload } = useMemoryVault(vault);
  const [coreDraft, setCoreDraft] = useState<string | null>(null);
  const [savingCore, setSavingCore] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<MemoryNoteType | 'all'>('all');
  const [dialog, setDialog] = useState<MemoryDialogTarget | null>(null);
  const shared = vault.kind === 'shared';

  /** Saves the core; the draft is dropped only once it is stored. */
  const saveCore = async (text: string): Promise<boolean> => {
    setSavingCore(true);
    const reply = await ipcBridge.agentMemory.setCore.invoke({ vault, text }).catch((): null => null);
    setSavingCore(false);
    if (!reply?.success) {
      messageApi.error(t(memoryErrorKey(reply?.msg, 'agent.memory.core.saveFailed')));
      return false;
    }
    setCore(text);
    setCoreDraft(null);
    return true;
  };

  const handlePin = async (note: MemoryNote): Promise<void> => {
    const next = pinToCore(coreDraft ?? core, note);
    if (next.length > MEMORY_CORE_MAX_CHARS) {
      messageApi.error(t('agent.memory.core.full'));
      return;
    }
    if (await saveCore(next)) messageApi.success(t('agent.memory.pinned'));
  };

  const handleSaved = (saved: MemoryNote): void => {
    const meta = toMeta(saved);
    setNotes((prev) => {
      const list = prev ?? [];
      return list.some((n) => n.id === meta.id) ? list.map((n) => (n.id === meta.id ? meta : n)) : [meta, ...list];
    });
    setDialog(null);
  };

  const handleWriteFailed = (code: string | undefined): void => {
    const message = t(memoryErrorKey(code, 'agent.memory.saveFailed'));
    if (code !== 'stale' && code !== 'not-found') {
      messageApi.error(message);
      return;
    }
    // Changed (or retired) elsewhere since it was opened: show the latest instead of overwriting it.
    messageApi.warning(message);
    setDialog(null);
    void reload();
  };

  const handleOpenFolder = async (): Promise<void> => {
    const reply = await ipcBridge.agentMemory.openFolder.invoke({ vault }).catch((): null => null);
    if (!reply?.success) messageApi.error(t('agent.memory.openFolderFailed'));
  };

  const shown = filterMemoryNotes(notes ?? [], query, typeFilter).toSorted((a, b) =>
    b.updated.localeCompare(a.updated)
  );

  return (
    <div className='flex flex-col gap-12px' data-testid={`memory-vault-${vault.kind}`}>
      {messageContext}
      {shared ? <div className='text-12px leading-18px text-t-tertiary'>{t('agent.memory.sharedHint')}</div> : null}
      {loadFailed ? (
        <div className='flex items-center gap-8px text-13px text-t-secondary'>
          {t('agent.memory.loadFailed')}
          <Button size='small' type='text' onClick={() => void reload()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <>
          <MemoryCoreEditor
            value={coreDraft ?? core}
            dirty={coreDraft !== null && coreDraft !== core}
            saving={savingCore}
            onChange={setCoreDraft}
            onSave={() => void saveCore(coreDraft ?? core)}
          />
          <MemoryHealth
            vault={vault}
            notes={notes}
            message={messageApi}
            onOpen={(id) => setDialog({ mode: 'edit', id })}
            onChanged={() => void reload()}
          />
          <div className='flex flex-wrap items-center gap-8px'>
            <Input
              className='min-w-160px flex-1'
              allowClear
              prefix={<Search theme='outline' size='14' />}
              value={query}
              onChange={setQuery}
              placeholder={t('agent.memory.search')}
              data-testid='memory-search'
            />
            <Select
              className='!w-180px'
              value={typeFilter}
              onChange={(value: MemoryNoteType | 'all') => setTypeFilter(value)}
              data-testid='memory-type-filter'
            >
              <Select.Option value='all'>{t('agent.memory.allTypes')}</Select.Option>
              {MEMORY_NOTE_TYPES.map((type) => (
                <Select.Option key={type} value={type}>
                  {t(memoryTypeKey(type))}
                </Select.Option>
              ))}
            </Select>
            <Button
              type='outline'
              size='small'
              className='!rounded-full !inline-flex items-center gap-4px'
              icon={<Plus theme='outline' size='14' />}
              onClick={() => setDialog({ mode: 'create', type: shared ? 'preference' : 'instructions' })}
            >
              {t('agent.memory.addNote')}
            </Button>
            {isElectronDesktop() ? (
              <Button
                type='text'
                size='small'
                className='!inline-flex items-center gap-4px'
                icon={<FolderOpen theme='outline' size='14' />}
                onClick={() => void handleOpenFolder()}
              >
                {t('agent.memory.openFolder')}
              </Button>
            ) : null}
          </div>
          {notes === null ? null : shown.length === 0 ? (
            <div className='text-13px text-t-secondary'>
              {t(notes.length === 0 ? 'agent.memory.empty' : 'agent.memory.noMatch')}
            </div>
          ) : (
            <MemoryNoteList notes={shown} shared={shared} onOpen={(note) => setDialog({ mode: 'edit', id: note.id })} />
          )}
        </>
      )}
      <MemoryNoteDialog
        vault={vault}
        shared={shared}
        target={dialog}
        message={messageApi}
        onClose={() => setDialog(null)}
        onSaved={handleSaved}
        onRetired={(id) => {
          setNotes((prev) => prev?.filter((n) => n.id !== id) ?? prev);
          setDialog(null);
        }}
        onWriteFailed={handleWriteFailed}
        onPin={(note) => void handlePin(note)}
      />
    </div>
  );
};

export default MemoryVaultView;
