/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MEMORY_CORE_MAX_CHARS } from './memoryLabels';

type MemoryCoreEditorProps = {
  value: string;
  dirty: boolean;
  saving: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
};

/** The vault's pinned facts: always in the agent's instructions, edited and saved as one text. */
const MemoryCoreEditor: React.FC<MemoryCoreEditorProps> = ({ value, dirty, saving, onChange, onSave }) => {
  const { t } = useTranslation();
  return (
    <div className='rounded-10px bg-fill-1 p-12px' data-testid='memory-core'>
      <div className='mb-4px text-13px font-500 text-t-primary'>{t('agent.memory.core.title')}</div>
      <div className='mb-8px text-12px leading-18px text-t-tertiary'>{t('agent.memory.core.hint')}</div>
      <Input.TextArea
        value={value}
        onChange={onChange}
        maxLength={MEMORY_CORE_MAX_CHARS}
        showWordLimit
        autoSize={{ minRows: 2, maxRows: 8 }}
        placeholder={t('agent.memory.core.placeholder')}
        data-testid='memory-core-input'
      />
      <div className='mt-8px flex justify-end'>
        <Button
          size='small'
          type='primary'
          className='!rounded-full'
          disabled={!dirty}
          loading={saving}
          onClick={onSave}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
};

export default MemoryCoreEditor;
