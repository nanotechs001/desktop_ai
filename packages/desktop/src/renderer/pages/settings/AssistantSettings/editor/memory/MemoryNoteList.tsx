/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryNoteMeta } from '@/common/types/agent/memory';
import { Tag } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MEMORY_SOURCE_COLORS, memorySourceKey, memoryTypeKey } from './memoryLabels';

type MemoryNoteListProps = {
  notes: MemoryNoteMeta[];
  shared: boolean;
  onOpen: (note: MemoryNoteMeta) => void;
};

/** The vault's notes, newest first: type, title, summary and who wrote it; replaced notes are dimmed. */
const MemoryNoteList: React.FC<MemoryNoteListProps> = ({ notes, shared, onOpen }) => {
  const { t } = useTranslation();
  return (
    <div className='space-y-4px'>
      {notes.map((note) => {
        const superseded = note.status === 'superseded';
        return (
          <div
            key={note.id}
            role='button'
            tabIndex={0}
            data-testid='memory-note'
            className={`cursor-pointer rounded-8px px-8px py-6px hover:bg-fill-2 ${superseded ? 'opacity-60' : ''}`}
            onClick={() => onOpen(note)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onOpen(note);
            }}
          >
            <div className='flex items-center gap-8px min-w-0'>
              <Tag size='small' className='flex-shrink-0'>
                {t(memoryTypeKey(note.type))}
              </Tag>
              <span className='min-w-0 flex-1 truncate text-13px font-500 text-t-primary'>{note.title}</span>
              {superseded ? (
                <Tag size='small' className='flex-shrink-0'>
                  {t('agent.memory.superseded')}
                </Tag>
              ) : null}
              <Tag size='small' color={MEMORY_SOURCE_COLORS[note.source]} className='flex-shrink-0'>
                {t(memorySourceKey(note, shared))}
              </Tag>
            </div>
            {note.summary ? (
              <div className='mt-2px break-words text-12px leading-18px text-t-secondary'>{note.summary}</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

export default MemoryNoteList;
