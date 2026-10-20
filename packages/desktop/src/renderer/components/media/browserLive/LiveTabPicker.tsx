/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Radio } from '@arco-design/web-react';
import type { LiveTab } from './useLiveTabs';

type LiveTabPickerProps = {
  tabs: LiveTab[];
  selectedId: string | undefined;
  onPick: (id: string) => void;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** A row of the conversation's desktop tabs, shown above the live picture when there are two or more. */
const LiveTabPicker: React.FC<LiveTabPickerProps> = ({ tabs, selectedId, onPick }) => {
  const { t } = useTranslation();
  return (
    <div
      role='group'
      aria-label={t('preview.browser.liveTabSelect')}
      className='flex items-center gap-8px px-8px py-6px border-0 border-b border-solid border-b-base'
    >
      <span className='text-12px text-t-secondary whitespace-nowrap flex-shrink-0'>
        {t('preview.browser.liveTabCount', { count: tabs.length })}
      </span>
      <div className='flex-1 min-w-0 overflow-x-auto'>
        <Radio.Group
          type='button'
          size='small'
          className='flex flex-nowrap'
          value={selectedId}
          onChange={(id: string) => onPick(id)}
          options={tabs.map((tab) => ({
            value: tab.id,
            label: <span className='block max-w-140px truncate'>{tab.title || hostOf(tab.url)}</span>,
          }))}
        />
      </div>
    </div>
  );
};

export default LiveTabPicker;
