/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Popover, Tooltip } from '@arco-design/web-react';
import { Exchange } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import LimitSwitchActions from './LimitSwitchActions';

/**
 * Chat header action: continue this chat on another engine or model at any time, through the same picker and hand-off
 * the usage-limit bar uses.
 */
const EngineSwitchButton: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = t('conversation.agentError.switch.headerButton');
  return (
    <Popover
      trigger='click'
      position='br'
      popupVisible={open}
      onVisibleChange={setOpen}
      content={
        <div className='max-w-360px'>
          {open && (
            <LimitSwitchActions conversationId={conversationId} reason='manual' onSwitched={() => setOpen(false)} />
          )}
        </div>
      }
    >
      {/* Hidden while the picker is open, which would otherwise sit under the hover tooltip. */}
      <Tooltip content={label} {...(open ? { popupVisible: false } : {})}>
        <Button size='mini' aria-label={label} icon={<Exchange theme='outline' size='14' />} />
      </Tooltip>
    </Popover>
  );
};

export default EngineSwitchButton;
