/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input, Message, Popconfirm, Popover, Tag, Typography } from '@arco-design/web-react';
import { Delete, Plus } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { parseError } from '@/common/utils';
import {
  currentWindows,
  hasSubscriptionWindows,
  usageOfEngine,
  useAllSubscriptionUsage,
  type UsageWindow,
} from '@/renderer/pages/conversation/components/limitSwitch/subscriptionUsage';
import {
  ENGINE_ACCOUNT_STATUS_SWR_KEY,
  fetchEngineAccountSignedIn,
  type ManagedAgent,
} from '@/renderer/utils/model/agentTypes';
import { isWindows } from '@/renderer/utils/platform';
import { copyText } from '@/renderer/utils/ui/clipboard';

const PREFIX = 'settings.agentManagement.accounts';
/** Engines whose CLI keeps a login per config dir; mirrors aioncore `services/account.rs`. */
const ACCOUNT_BACKENDS: ReadonlySet<string> = new Set(['claude']);
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const CLI = 'claude';

export const isEngineAccount = (agent: ManagedAgent): boolean => Boolean(agent.agent_source_info?.account_of);

/** Only a builtin engine's main row takes accounts. */
export const canAddEngineAccount = (agent: ManagedAgent): boolean =>
  agent.agent_source === 'builtin' && !isEngineAccount(agent) && ACCOUNT_BACKENDS.has(agent.backend ?? '');

/** The terminal command that runs the CLI on the account's own config dir, where `/login` signs it in. */
const signInCommand = (agent: ManagedAgent): string | null => {
  const dir = agent.agent_source_info?.account_dir;
  if (!dir) return null;
  return isWindows()
    ? `$env:${CONFIG_DIR_ENV}='${dir.replace(/'/g, "''")}'; ${CLI}`
    : `${CONFIG_DIR_ENV}='${dir.replace(/'/g, `'\\''`)}' ${CLI}`;
};

type AccountProps = { agent: ManagedAgent; onChanged: () => void | Promise<void> };

/** On an engine's main row: adds another login of it as its own engine. */
export const AddEngineAccountButton: React.FC<AccountProps> = ({ agent, onChanged }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      await ipcBridge.acpConversation.createAgentAccount.invoke({ id: agent.id, label: label.trim() });
      Message.success(t(`${PREFIX}.added`));
      setOpen(false);
      setLabel('');
      await onChanged();
    } catch (error) {
      console.error('[EngineAccounts] add account failed:', error);
      Message.error(parseError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      trigger='click'
      position='bl'
      popupVisible={open}
      onVisibleChange={setOpen}
      content={
        <div className='flex w-260px flex-col gap-8px'>
          <Typography.Text className='text-12px text-t-secondary'>{t(`${PREFIX}.addHelp`)}</Typography.Text>
          <Input
            autoFocus
            size='small'
            value={label}
            placeholder={t(`${PREFIX}.labelPlaceholder`)}
            onChange={setLabel}
            onPressEnter={() => label.trim() && void create()}
          />
          <Button size='small' type='primary' disabled={!label.trim()} loading={busy} onClick={() => void create()}>
            {t(`${PREFIX}.create`)}
          </Button>
        </div>
      }
    >
      <Button size='small' type='outline' icon={<Plus theme='outline' size='12' />}>
        {t(`${PREFIX}.add`)}
      </Button>
    </Popover>
  );
};

/**
 * On an account row: whether it is signed in, Sign in (a terminal on the account's CLI; if that cannot open, the
 * command to run by hand), and removing it.
 */
export const EngineAccountActions: React.FC<AccountProps> = ({ agent, onChanged }) => {
  const { t } = useTranslation();
  const command = signInCommand(agent);
  // Refetched when the window regains focus, so the tag clears once the user is back from the terminal.
  const { data: signedIn } = useSWR(ENGINE_ACCOUNT_STATUS_SWR_KEY, fetchEngineAccountSignedIn);
  const [showCommand, setShowCommand] = useState(false);

  const signIn = async (): Promise<void> => {
    try {
      await ipcBridge.acpConversation.signInAgentAccount.invoke({ id: agent.id });
      Message.info(t(`${PREFIX}.signInOpened`));
    } catch (error) {
      console.error('[EngineAccounts] sign-in terminal failed:', error);
      Message.error(parseError(error));
      setShowCommand(true);
    }
  };

  const remove = async (): Promise<void> => {
    try {
      await ipcBridge.acpConversation.deleteAgentAccount.invoke({ id: agent.id });
      await onChanged();
    } catch (error) {
      console.error('[EngineAccounts] delete account failed:', error);
      Message.error(parseError(error));
    }
  };
  const copy = async (text: string): Promise<void> => {
    try {
      await copyText(text);
      Message.success(t(`${PREFIX}.copied`));
    } catch (error) {
      console.error('[EngineAccounts] copy failed:', error);
      Message.error(parseError(error));
    }
  };

  return (
    <>
      {signedIn?.[agent.id] === false && (
        <Tag size='small' color='orange'>
          {t(`${PREFIX}.notSignedIn`)}
        </Tag>
      )}
      {command && (
        // Opened only by a failed Sign in; a click elsewhere closes it.
        <Popover
          trigger='click'
          position='bl'
          popupVisible={showCommand}
          onVisibleChange={(visible) => !visible && setShowCommand(false)}
          content={
            <div className='flex max-w-420px flex-col gap-8px'>
              <Typography.Text className='text-12px text-t-secondary'>{t(`${PREFIX}.signInHelp`)}</Typography.Text>
              <Typography.Text code className='break-all text-12px'>
                {command}
              </Typography.Text>
              <Button size='small' onClick={() => void copy(command)}>
                {t(`${PREFIX}.copy`)}
              </Button>
            </div>
          }
        >
          <Button size='small' type='outline' onClick={() => void signIn()}>
            {t(`${PREFIX}.signIn`)}
          </Button>
        </Popover>
      )}
      <Popconfirm
        title={t(`${PREFIX}.deleteTitle`)}
        content={t(`${PREFIX}.deleteHelp`)}
        okText={t(`${PREFIX}.deleteConfirm`)}
        onOk={() => remove()}
      >
        <Button
          size='small'
          type='outline'
          status='danger'
          aria-label={t(`${PREFIX}.delete`)}
          icon={<Delete theme='outline' size='14' />}
        />
      </Popconfirm>
    </>
  );
};

const toPct = (w: UsageWindow | undefined): number => Math.round((w?.utilization ?? 0) * 100);

/** The login's 5-hour and weekly plan usage, once a chat on it has reported one. */
export const EngineUsageLine: React.FC<{ agent: ManagedAgent }> = ({ agent }) => {
  const { t } = useTranslation();
  const usage = usageOfEngine(useAllSubscriptionUsage(), agent);
  const now = Date.now();
  if (!hasSubscriptionWindows(usage, now)) return null;
  const windows = currentWindows(usage, now);
  return (
    <Typography.Text className='block truncate text-12px text-t-tertiary'>
      {t(`${PREFIX}.usage`, { fiveHour: toPct(windows.five_hour), week: toPct(windows.seven_day) })}
    </Typography.Text>
  );
};
