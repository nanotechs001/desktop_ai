/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Button, Message, Select, Slider, Switch } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import {
  MAX_WIDGET_SCALE,
  MIN_WIDGET_SCALE,
  type AgentWidgetMovementFrequency,
  type AgentWidgetSettings,
} from '@/common/types/agent/agentWidget';
import { useAgentWidgetSettings } from '@/renderer/pages/agentWidget/useAgentWidgetSync';
import { isElectronDesktop } from '@/renderer/utils/platform';
import PreferenceRow from './PreferenceRow';

const FREQUENCIES: AgentWidgetMovementFrequency[] = ['low', 'medium', 'high'];

/** Floating desktop agent widgets (desktop app only — the windows are native). */
const AgentWidgetSection: React.FC = () => {
  const { t } = useTranslation();
  const settings = useAgentWidgetSettings();
  if (!isElectronDesktop() || !settings) return null;

  // The main process merges, validates, persists and broadcasts; the hook picks up the broadcast.
  const update = (patch: Partial<AgentWidgetSettings>) => {
    ipcBridge.agentWidget.setSettings.invoke(patch).catch(() => Message.error(t('common.error')));
  };
  const returnAllChats = async () => {
    const locations = await ipcBridge.agentWidget.getChatLocations.invoke();
    await Promise.all(
      Object.keys(locations).map((conversation_id) =>
        ipcBridge.agentWidget.setChatLocation.invoke({ conversation_id, location: 'main' })
      )
    );
  };
  const off = !settings.enabled;

  return (
    <div className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
      <div className='text-14px font-medium text-t-primary mb-8px'>{t('pet.widget.settings.title')}</div>
      <PreferenceRow label={t('pet.widget.settings.enabled')} description={t('pet.widget.settings.enabledDesc')}>
        <Switch checked={settings.enabled} onChange={(enabled) => update({ enabled })} />
      </PreferenceRow>
      <PreferenceRow label={t('pet.widget.settings.autoLaunch')}>
        <Switch checked={settings.autoLaunch} disabled={off} onChange={(autoLaunch) => update({ autoLaunch })} />
      </PreferenceRow>
      <PreferenceRow label={t('pet.widget.settings.movement')}>
        <Switch
          checked={settings.autonomousMovement}
          disabled={off}
          onChange={(autonomousMovement) => update({ autonomousMovement })}
        />
      </PreferenceRow>
      <PreferenceRow label={t('pet.widget.settings.movementFrequency')}>
        <Select
          className='w-140px'
          value={settings.movementFrequency}
          disabled={off || !settings.autonomousMovement}
          onChange={(movementFrequency: AgentWidgetMovementFrequency) => update({ movementFrequency })}
          options={FREQUENCIES.map((value) => ({ value, label: t(`pet.widget.settings.frequency.${value}`) }))}
        />
      </PreferenceRow>
      <PreferenceRow label={t('pet.widget.settings.scale')}>
        <Slider
          className='w-160px'
          min={MIN_WIDGET_SCALE}
          max={MAX_WIDGET_SCALE}
          step={0.25}
          value={settings.scale}
          disabled={off}
          formatTooltip={(value) => `${Math.round(value * 100)}%`}
          onAfterChange={(value) => update({ scale: Array.isArray(value) ? value[0] : value })}
        />
      </PreferenceRow>
      <PreferenceRow label={t('pet.widget.settings.alwaysOnTop')}>
        <Switch checked={settings.alwaysOnTop} disabled={off} onChange={(alwaysOnTop) => update({ alwaysOnTop })} />
      </PreferenceRow>
      <PreferenceRow
        label={t('pet.widget.settings.reduceMotion')}
        description={t('pet.widget.settings.reduceMotionDesc')}
      >
        <Switch checked={settings.reduceMotion} disabled={off} onChange={(reduceMotion) => update({ reduceMotion })} />
      </PreferenceRow>
      <PreferenceRow label={t('pet.widget.settings.muteVoice')} description={t('pet.widget.settings.muteVoiceDesc')}>
        <Switch checked={settings.muteVoice} disabled={off} onChange={(muteVoice) => update({ muteVoice })} />
      </PreferenceRow>
      <PreferenceRow label={t('pet.widget.settings.returnChats')}>
        <Button size='small' disabled={off} onClick={() => void returnAllChats().catch(() => {})}>
          {t('pet.widget.returnChatHere')}
        </Button>
      </PreferenceRow>
    </div>
  );
};

export default AgentWidgetSection;
