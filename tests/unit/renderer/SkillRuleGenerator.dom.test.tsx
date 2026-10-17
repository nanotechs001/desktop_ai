/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SkillRuleGenerator from '@/renderer/pages/conversation/components/SkillRuleGenerator';
import { loadLatestConversationMessages } from '@/renderer/utils/chat/messagePagination';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  responseStreamOn: vi.fn(),
  loadLatestConversationMessages: vi.fn(),
  createAssistant: vi.fn(),
  ensureAgentRule: vi.fn(),
  writeAssistantRule: vi.fn(),
  defaultEngineId: 'engine-1' as string | null,
}));

vi.mock('@/renderer/hooks/agent/useDefaultEngine', () => ({
  useDefaultEngine: () => ({ agentId: mocks.defaultEngineId }),
}));
vi.mock('swr', () => ({ mutate: vi.fn() }));
vi.mock('@/common/utils', () => ({ uuid: () => 'msg-generated' }));

vi.mock('@arco-design/web-react', () => {
  const Button = ({ children, icon, ...props }: any) => (
    <button type='button' {...props}>
      {icon}
      {children}
    </button>
  );
  const Dropdown = ({ children, droplist }: any) => (
    <div>
      {children}
      <div>{droplist}</div>
    </div>
  );
  const Menu = ({ children }: any) => <div>{children}</div>;
  Menu.Item = ({ children, onClick }: any) => (
    <button type='button' onClick={onClick}>
      {children}
    </button>
  );
  const Modal = ({ children, visible, onOk, okText }: any) =>
    visible ? (
      <div role='dialog'>
        {children}
        <button type='button' onClick={onOk}>
          {okText}
        </button>
      </div>
    ) : null;
  const Radio = ({ children }: any) => <label>{children}</label>;
  Radio.Group = ({ children }: any) => <div>{children}</div>;

  return {
    Button,
    Dropdown,
    Empty: () => <div />,
    Input: ({ onChange, placeholder, value }: any) => (
      <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    ),
    List: () => <div />,
    Menu,
    Message: {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
    },
    Modal,
    Radio,
    Spin: ({ children }: any) => <div>{children}</div>,
    Typography: {
      Text: ({ children }: any) => <span>{children}</span>,
    },
  };
});

vi.mock('@icon-park/react', () => ({
  FolderOpen: () => <span />,
  Lightning: () => <span />,
  Magic: () => <span />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      refreshCustomAgents: {
        invoke: vi.fn(),
      },
    },
    assistants: {
      create: {
        invoke: mocks.createAssistant,
      },
    },
    agentBrowser: {
      ensureAgentRule: { invoke: mocks.ensureAgentRule },
    },
    conversation: {
      responseStream: {
        on: mocks.responseStreamOn,
      },
      sendMessage: {
        invoke: mocks.sendMessage,
      },
    },
    fs: {
      getFilesByDir: {
        invoke: vi.fn(),
      },
      readFile: {
        invoke: vi.fn(),
      },
      writeAssistantRule: {
        invoke: mocks.writeAssistantRule,
      },
    },
  },
  uuid: () => 'msg-generated',
}));

vi.mock('@/renderer/utils/chat/messagePagination', () => ({
  loadLatestConversationMessages: mocks.loadLatestConversationMessages,
}));

const loadLatestMessages = vi.mocked(loadLatestConversationMessages);

describe('SkillRuleGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.responseStreamOn.mockReturnValue(() => {});
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.defaultEngineId = 'engine-1';
    mocks.createAssistant.mockResolvedValue({ id: 'preset-1' });
    mocks.ensureAgentRule.mockResolvedValue({ success: true });
    mocks.loadLatestConversationMessages.mockResolvedValue({
      items: [
        {
          id: 'msg-1',
          conversation_id: 'conversation-1',
          msg_id: 'msg-1',
          type: 'text',
          position: 'right',
          content: { content: 'Summarize this repository' },
        },
      ],
      oldest_cursor: null,
      newest_cursor: null,
      has_more_before: false,
      has_more_after: false,
    });
  });

  it('loads the latest compact message window when generating from history', async () => {
    render(<SkillRuleGenerator conversation_id='conversation-1' workspace='/tmp/workspace' />);

    fireEvent.click(screen.getByText('Generate from History'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(screen.getByPlaceholderText('e.g. Excel Translator'), {
      target: { value: 'Repo Summarizer' },
    });
    fireEvent.click(within(dialog).getByText('Generate'));

    await waitFor(() => {
      expect(loadLatestMessages).toHaveBeenCalledWith('conversation-1', {
        limit: 50,
        contentMode: 'compact',
      });
    });
  });

  it('registers the generated preset as an Agent on the default engine, with its rule written through main', async () => {
    render(<SkillRuleGenerator conversation_id='conversation-1' workspace='/tmp/workspace' />);
    fireEvent.click(screen.getByText('Generate from History'));
    fireEvent.change(screen.getByPlaceholderText('e.g. Excel Translator'), { target: { value: 'Repo Summarizer' } });
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Generate'));
    await waitFor(() => expect(mocks.responseStreamOn).toHaveBeenCalled());
    const onStream = mocks.responseStreamOn.mock.calls[0][0] as (msg: Record<string, unknown>) => void;

    const reply = { conversation_id: 'conversation-1', msg_id: 'msg-generated' };
    onStream({ ...reply, type: 'content', data: 'Saved. ---PRESET_BEGIN---Summarize repos.---PRESET_END---' });
    onStream({ ...reply, type: 'finish' });

    await waitFor(() =>
      expect(mocks.ensureAgentRule).toHaveBeenCalledWith({ assistantId: 'preset-1', content: 'Summarize repos.' })
    );
    expect(mocks.createAssistant).toHaveBeenCalledWith({ name: 'Repo Summarizer', agent_id: 'engine-1' });
    expect(mocks.writeAssistantRule).not.toHaveBeenCalled();
  });
});
