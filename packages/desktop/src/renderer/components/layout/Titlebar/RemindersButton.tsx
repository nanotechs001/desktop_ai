/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Badge, Button, DatePicker, Dropdown, Input, Menu, Message, Popover } from '@arco-design/web-react';
import { Remind } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { isReminderDue, type Reminder } from '@/common/types/agent/reminders';

const KEY = 'common.reminders';
const MINUTE_MS = 60_000;
/** A new reminder without a picked time is due in an hour. */
const DEFAULT_DUE_MS = 60 * MINUTE_MS;
/** setTimeout's longest delay; a later due time waits in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Minutes from now until tomorrow at 9:00, local time. */
const minutesToTomorrowMorning = (now: number): number => {
  const morning = new Date(now);
  morning.setDate(morning.getDate() + 1);
  morning.setHours(9, 0, 0, 0);
  return Math.ceil((morning.getTime() - now) / MINUTE_MS);
};

const formatDue = (dueAt: number): string =>
  new Date(dueAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Keeps a popup inside the list's popover, so picking from it does not close the list. */
const insidePopover = (node: HTMLElement): Element => node.parentElement ?? document.body;

type RemindersButtonProps = { buttonClassName: string; iconSize: number };

/**
 * Titlebar bell: the user's reminder list, with a red dot while any reminder is due. Reminders can be added, snoozed,
 * moved to another time and marked done. Bots set reminders in the same list through their reminder tools.
 */
const RemindersButton: React.FC<RemindersButtonProps> = ({ buttonClassName, iconSize }) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<Reminder[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [title, setTitle] = useState('');
  const [pickedDue, setPickedDue] = useState<number | null>(null);
  const gotEvent = useRef(false);

  useEffect(() => {
    const off = ipcBridge.reminders.changed.on((next) => {
      gotEvent.current = true;
      setItems(next);
      setNow(Date.now());
    });
    // A change that arrived first is newer than this read, so it wins.
    void ipcBridge.reminders.list
      .invoke()
      .then((res) => {
        if (res.success && res.data && !gotEvent.current) setItems(res.data);
      })
      .catch((error: unknown) => console.warn('[RemindersButton] could not read the reminders:', error));
    return off;
  }, []);

  const open = items.filter((item) => item.doneAt === null);
  const dueCount = open.filter((item) => isReminderDue(item, now)).length;
  const nextDue = Math.min(...open.filter((item) => item.dueAt > now).map((item) => item.dueAt));

  // Wakes up when the next reminder comes due, so the bell turns red right then.
  useEffect(() => {
    if (!Number.isFinite(nextDue)) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(nextDue - now, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [nextDue, now]);

  const run = (request: Promise<{ success: boolean; msg?: string }>): void => {
    void request
      .then((res) => {
        if (res.success) return;
        console.warn('[RemindersButton] reminder change refused:', res.msg);
        Message.error(t(`${KEY}.failed`));
      })
      .catch((error: unknown) => {
        console.warn('[RemindersButton] reminder change failed:', error);
        Message.error(t(`${KEY}.failed`));
      });
  };

  const addReminder = (): void => {
    const text = title.trim();
    if (!text) return;
    run(ipcBridge.reminders.add.invoke({ title: text, dueAt: pickedDue ?? Date.now() + DEFAULT_DUE_MS }));
    setTitle('');
    setPickedDue(null);
  };

  const snooze = (id: string, key: string): void => {
    const minutes = key === '10m' ? 10 : key === '1h' ? 60 : minutesToTomorrowMorning(Date.now());
    run(ipcBridge.reminders.snooze.invoke({ id, minutes }));
  };

  const row = (item: Reminder) => {
    const due = isReminderDue(item, now);
    return (
      <div key={item.id} className='py-6px border-b border-solid border-[var(--border-base)] last:border-b-0'>
        <div className='flex items-baseline gap-6px'>
          <span className={`flex-1 min-w-0 truncate text-t-primary ${due ? 'font-bold' : ''}`}>{item.title}</span>
          <span className={`text-12px flex-shrink-0 ${due ? 'text-danger' : 'text-t-secondary'}`}>
            {due ? t(`${KEY}.due`) : formatDue(item.dueAt)}
          </span>
        </div>
        {item.note && <div className='text-12px text-t-secondary truncate'>{item.note}</div>}
        <div className='flex gap-4px mt-4px'>
          <Button
            size='mini'
            type='primary'
            aria-label={t(`${KEY}.done`)}
            onClick={() => run(ipcBridge.reminders.done.invoke({ id: item.id }))}
          >
            {t(`${KEY}.done`)}
          </Button>
          <Dropdown
            trigger='click'
            getPopupContainer={insidePopover}
            droplist={
              <Menu onClickMenuItem={(key) => snooze(item.id, key)}>
                <Menu.Item key='10m'>{t(`${KEY}.snooze10m`)}</Menu.Item>
                <Menu.Item key='1h'>{t(`${KEY}.snooze1h`)}</Menu.Item>
                <Menu.Item key='tomorrow'>{t(`${KEY}.snoozeTomorrow`)}</Menu.Item>
              </Menu>
            }
          >
            <Button size='mini' aria-label={t(`${KEY}.snooze`)}>
              {t(`${KEY}.snooze`)}
            </Button>
          </Dropdown>
          <DatePicker
            showTime
            getPopupContainer={insidePopover}
            onOk={(_text, date) => run(ipcBridge.reminders.reschedule.invoke({ id: item.id, dueAt: date.valueOf() }))}
            triggerElement={
              <Button size='mini' aria-label={t(`${KEY}.move`)}>
                {t(`${KEY}.move`)}
              </Button>
            }
          />
        </div>
      </div>
    );
  };

  const content = (
    <div className='w-340px'>
      <div className='font-bold mb-8px'>{t(`${KEY}.title`)}</div>
      <div className='flex flex-col gap-6px mb-8px'>
        <Input
          size='small'
          value={title}
          placeholder={t(`${KEY}.newPlaceholder`)}
          maxLength={200}
          onChange={setTitle}
          onPressEnter={addReminder}
        />
        <div className='flex gap-6px'>
          <DatePicker
            showTime
            size='small'
            className='flex-1'
            placeholder={t(`${KEY}.inAnHour`)}
            getPopupContainer={insidePopover}
            value={pickedDue ?? undefined}
            onChange={(_text, date) => setPickedDue(date ? date.valueOf() : null)}
          />
          <Button
            size='small'
            type='primary'
            aria-label={t(`${KEY}.add`)}
            disabled={!title.trim()}
            onClick={addReminder}
          >
            {t(`${KEY}.add`)}
          </Button>
        </div>
      </div>
      <div className='max-h-360px overflow-y-auto'>
        {open.length === 0 ? <div className='text-t-secondary'>{t(`${KEY}.empty`)}</div> : open.map(row)}
      </div>
    </div>
  );

  return (
    <Popover trigger='click' position='br' content={content}>
      <Button
        type='text'
        size='mini'
        className={buttonClassName}
        aria-label={t(`${KEY}.title`)}
        title={dueCount > 0 ? t(`${KEY}.dueCount`, { count: dueCount }) : t(`${KEY}.title`)}
        icon={
          <Badge dot count={dueCount}>
            <Remind theme='outline' size={iconSize} fill='currentColor' className='block leading-none' />
          </Badge>
        }
      />
    </Popover>
  );
};

export default RemindersButton;
