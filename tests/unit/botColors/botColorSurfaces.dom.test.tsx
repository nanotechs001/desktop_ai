/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The bot color dot on the list and history surfaces: drawn for user-made VA Bots only, never for built-in Agents
 * or regular (default Agent) chats. The other surfaces use the same VaBotColorDot component.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService } from '@/common/config/configService';
import type { TChatConversation } from '@/common/config/storage';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key }),
}));
vi.mock('@/renderer/utils/platform', () => ({ resolveExtensionAssetUrl: vi.fn(() => null) }));
vi.mock('@/renderer/hooks/agent/useManagedAgents', () => ({ useManagedAgentRuntimeCatalog: () => [] }));
vi.mock('@/renderer/pages/settings/AssistantSettings/AssistantAvatar', () => ({ default: () => <div /> }));
vi.mock('@/renderer/pages/settings/AssistantSettings/home/RuntimeBadge', () => ({ default: () => <div /> }));
vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({ usePresetAssistantInfo: () => ({ info: null }) }));
vi.mock('@/renderer/utils/model/agentLogo', () => ({ useAgentLogos: () => ({}) }));
vi.mock('@/renderer/pages/cron', () => ({ CronJobIndicator: () => null }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));

import ConversationRow from '@/renderer/pages/conversation/GroupedHistory/ConversationRow';
import type { ConversationRowProps } from '@/renderer/pages/conversation/GroupedHistory/types';
import AssistantSelectionArea from '@/renderer/pages/guid/components/AssistantSelectionArea';
import EnabledAssistantsList from '@/renderer/pages/settings/AssistantSettings/home/EnabledAssistantsList';
import MyAssistantCard from '@/renderer/pages/settings/AssistantSettings/home/MyAssistantCard';

const COLOR = '#3e63dd';
const COLOR_CSS = 'rgb(62, 99, 221)';

beforeEach(() => {
  configService.setLocal('agent.colors', { bot: COLOR, preset: COLOR, 'aion-default-agent': COLOR });
});
afterEach(cleanup);

/** The color dots inside `root` (the decorative, inline-colored spans). */
const dotsIn = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')).filter(
    (span) => span.style.backgroundColor === COLOR_CSS
  );

const listItem = (id: string, source: string): AssistantListItem =>
  ({
    id,
    source,
    name: id,
    name_i18n: {},
    description_i18n: {},
    enabled: true,
    sort_order: 1,
    agent_id: 'agent-1',
    agent: { type: 'claude', source: 'internal' },
    agent_status: 'online',
    enabled_skills: [],
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context_i18n: {},
    prompts: [],
  }) as unknown as AssistantListItem;

const BOT = listItem('bot', 'user');
const PRESET = listItem('preset', 'builtin');
const DEFAULT_AGENT = listItem('aion-default-agent', 'user');

describe('Agents page card', () => {
  const card = (assistant: AssistantListItem) =>
    render(
      <MyAssistantCard
        assistant={assistant}
        localeKey='en-US'
        onOpenDetail={vi.fn()}
        onDelete={vi.fn()}
        onToggleEnabled={vi.fn()}
        onStartChat={vi.fn()}
      />
    ).container;

  it('shows the bot color dot for a VA Bot', () => {
    expect(dotsIn(card(BOT))).toHaveLength(1);
  });

  it.each([
    ['a built-in Agent', PRESET],
    ['the default Agent', DEFAULT_AGENT],
  ])('shows no dot for %s', (_label, assistant) => {
    expect(dotsIn(card(assistant))).toHaveLength(0);
  });
});

describe('Agents page enabled list', () => {
  it('shows a dot on VA Bot rows only', () => {
    const { container } = render(
      <EnabledAssistantsList
        assistants={[BOT, PRESET, DEFAULT_AGENT]}
        assistantOrder={[]}
        localeKey='en-US'
        searchActive={false}
        onOpenDetail={vi.fn()}
        onToggleEnabled={vi.fn()}
        onReorder={vi.fn()}
        onStartChat={vi.fn()}
      />
    );
    const dotted = (id: string) => dotsIn(container.querySelector(`[data-testid="enabled-assistant-row-${id}"]`)!);
    expect(dotted('bot')).toHaveLength(1);
    expect(dotted('preset')).toHaveLength(0);
    expect(dotted('aion-default-agent')).toHaveLength(0);
  });
});

describe('Guid assistant pills', () => {
  it('shows a dot on VA Bot pills only', () => {
    const { container } = render(
      <ConfigProvider>
        <AssistantSelectionArea
          selectedAssistantId='bot'
          assistants={[BOT, PRESET] as unknown as Assistant[]}
          localeKey='en-US'
          onSelectAssistant={vi.fn()}
        />
      </ConfigProvider>
    );
    const pill = (id: string) => container.querySelector<HTMLElement>(`[data-assistant-id="${id}"]`)!;
    expect(dotsIn(pill('bot'))).toHaveLength(1);
    expect(dotsIn(pill('preset'))).toHaveLength(0);
  });
});

describe('History row', () => {
  const row = (assistant: { id: string; source: string } | undefined) => {
    const conversation = {
      id: 'conv-1',
      name: 'Chat',
      type: 'acp',
      created_at: 1,
      modified_at: 1,
      extra: {},
      assistant: assistant && { ...assistant, name: assistant.id, avatar: '', backend: 'claude' },
    } as unknown as TChatConversation;
    const props: ConversationRowProps = {
      conversation,
      isGenerating: false,
      isWaitingConfirmation: false,
      hasUnread: false,
      isManualUnread: false,
      collapsed: false,
      tooltipEnabled: false,
      batchMode: false,
      checked: false,
      selected: false,
      menuVisible: false,
      onToggleChecked: vi.fn(),
      onConversationClick: vi.fn(),
      onOpenMenu: vi.fn(),
      onMenuVisibleChange: vi.fn(),
      onEditStart: vi.fn(),
      onCreateCronTask: vi.fn(),
      onArchive: vi.fn(),
      onTogglePin: vi.fn(),
      onToggleManualUnread: vi.fn(),
      getJobStatus: () => 'none',
    };
    return render(<ConversationRow {...props} />).container;
  };

  it('shows the dot for a VA Bot chat', () => {
    expect(dotsIn(row({ id: 'bot', source: 'user' }))).toHaveLength(1);
  });

  it.each([
    ['a built-in Agent chat', { id: 'preset', source: 'builtin' }],
    ['a regular (default Agent) chat', { id: 'aion-default-agent', source: 'user' }],
    ['a chat without an Agent', undefined],
  ])('shows no dot for %s', (_label, assistant) => {
    expect(dotsIn(row(assistant))).toHaveLength(0);
  });
});
