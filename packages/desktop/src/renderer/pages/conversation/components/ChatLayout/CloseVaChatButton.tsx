/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Button, Tooltip } from '@arco-design/web-react';
import { Close } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';

/**
 * Chat header action for a VA bot whose chat sits under its browser: hides the chat in one click instead of dragging
 * the divider to the bottom. The browser's chat toggle brings it back.
 */
const CloseVaChatButton: React.FC = () => {
  const { t } = useTranslation();
  const { isVaBotMode, isOpen, isVaChatCollapsed, toggleVaChat } = usePreviewContext();
  if (!isVaBotMode || !isOpen || isVaChatCollapsed) return null;
  const label = t('preview.hideChat');
  return (
    <Tooltip content={label}>
      <Button size='mini' aria-label={label} icon={<Close theme='outline' size='14' />} onClick={toggleVaChat} />
    </Tooltip>
  );
};

export default CloseVaChatButton;
