/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Dropdown, Menu } from '@arco-design/web-react';
import { Down } from '@icon-park/react';
import classNames from 'classnames';
import React, { useCallback } from 'react';

export type AddActionExtra = {
  key: string;
  label: string;
  onClick: () => void;
};

export type AddActionButtonProps = {
  /** Button label in its plain, action-neutral form, e.g. "Create Agent", "Add model". */
  label: string;
  /** Optional "via chat" action. Only shown when the caller supplies both this and `chatLabel`. */
  onChat?: () => void;
  /** Menu label for the "via chat" item, e.g. "Create via chat". */
  chatLabel?: string;
  /** The manual action and its menu label. */
  onManual?: () => void;
  manualLabel?: string;
  /** Extra menu actions inserted before the manual item (e.g. MCP imports). */
  extraActions?: AddActionExtra[];
  type?: 'primary' | 'outline' | 'secondary' | 'default';
  size?: 'mini' | 'small' | 'default' | 'large';
  className?: string;
  'data-testid'?: string;
};

const CHAT_KEY = '__chat__';
const MANUAL_KEY = '__manual__';

/**
 * Unified "create/add" entry point used across settings. With a single action
 * it is a plain button that runs it; with several, clicking opens a dropdown
 * (extra actions, then the manual one, then the optional "via chat" one).
 */
const AddActionButton: React.FC<AddActionButtonProps> = ({
  label,
  onChat,
  chatLabel,
  onManual,
  manualLabel,
  extraActions,
  type = 'primary',
  size = 'small',
  className,
  ['data-testid']: testId,
}) => {
  const handleSelect = useCallback(
    (key: string) => {
      if (key === CHAT_KEY) onChat?.();
      else if (key === MANUAL_KEY) onManual?.();
      else extraActions?.find((action) => action.key === key)?.onClick();
    },
    [onChat, onManual, extraActions]
  );

  const buttonClass = classNames('!h-32px !rounded-8px !px-14px', className);
  const hasChat = Boolean(onChat && chatLabel);
  const extraCount = extraActions?.length ?? 0;

  // Nothing to choose between: the button is the action.
  if (!hasChat && extraCount === 0) {
    return (
      <Button type={type} size={size} className={buttonClass} data-testid={testId} onClick={onManual}>
        {label}
      </Button>
    );
  }

  const droplist = (
    <Menu onClickMenuItem={handleSelect}>
      {hasChat ? (
        <Menu.Item key={CHAT_KEY} data-testid={testId ? `${testId}-chat` : undefined}>
          {chatLabel}
        </Menu.Item>
      ) : null}
      {extraActions?.map((action) => (
        <Menu.Item key={action.key} data-testid={testId ? `${testId}-${action.key}` : undefined}>
          {action.label}
        </Menu.Item>
      ))}
      {onManual && manualLabel ? (
        <Menu.Item key={MANUAL_KEY} data-testid={testId ? `${testId}-manual` : undefined}>
          {manualLabel}
        </Menu.Item>
      ) : null}
    </Menu>
  );

  return (
    <Dropdown trigger='click' droplist={droplist} position='br'>
      <Button type={type} size={size} className={buttonClass} data-testid={testId}>
        <span className='flex items-center gap-6px'>
          {label}
          <Down theme='outline' size={14} fill='currentColor' />
        </span>
      </Button>
    </Dropdown>
  );
};

export default AddActionButton;
