/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlarmClock } from '@icon-park/react';
import SiderNavEntry, { type SiderNavEntryProps } from './SiderNavEntry';

const SiderScheduledEntry: React.FC<Omit<SiderNavEntryProps, 'label' | 'icon'>> = (props) => {
  const { t } = useTranslation();
  return <SiderNavEntry label={t('cron.scheduledTasks')} icon={AlarmClock} {...props} />;
};

export default SiderScheduledEntry;
