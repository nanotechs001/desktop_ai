/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The titlebar VA Bots button: a click opens the Agents dashboard; hovering (or focusing) it lists every VA Bot robot,
 * with Watch (its chat and browser in the main window) and Chat (its popup on the desktop). Hidden robots can also be
 * shown again by opening the bot's chat.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Robot = { conversation_id: string; agent_id?: string; hidden: boolean };

const h = vi.hoisted(() => ({
  robots: [] as Robot[],
  robotsListener: null as null | ((list: Robot[]) => void),
  hidden: [] as Array<{ conversation_id: string; agent_id?: string }>,
  ensure: vi.fn((_payload: unknown) => Promise.resolve(true)),
  openPopup: vi.fn((_payload: unknown) => Promise.resolve(true)),
  setChatLocation: vi.fn((_payload: unknown) => Promise.resolve()),
  navigate: vi.fn(),
  openDashboard: vi.fn(),
  revealBrowserFor: vi.fn(),
  conversations: {} as Record<
    string,
    { id: string; name?: string; assistant?: { id: string; name: string; source?: string } }
  >,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentWidget: {
      getSettings: { invoke: () => Promise.resolve({ enabled: true }) },
      settingsChanged: { on: () => () => {} },
      listHidden: { invoke: () => Promise.resolve(h.hidden) },
      listRobots: { invoke: () => Promise.resolve(h.robots) },
      robotsChanged: {
        on: (fn: typeof h.robotsListener) => {
          h.robotsListener = fn;
          return () => {
            h.robotsListener = null;
          };
        },
      },
      ensure: { invoke: (payload: unknown) => h.ensure(payload) },
      openPopup: { invoke: (payload: unknown) => h.openPopup(payload) },
      setChatLocation: { invoke: (payload: unknown) => h.setChatLocation(payload) },
    },
  },
}));

vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  isElectronDesktop: () => true,
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: (id: string) => Promise.resolve(h.conversations[id] ?? null),
}));

vi.mock('@renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ revealBrowserFor: h.revealBrowserFor }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => h.navigate }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { configService } from '@/common/config/configService';
import RobotListButton from '@/renderer/components/layout/Titlebar/RobotListButton';
import { useRestoreHiddenAgentWidget } from '@/renderer/pages/agentWidget/useAgentWidgetSync';

const renderButton = () =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <RobotListButton label='settings.assistants' icon={<span>orb</span>} onClick={h.openDashboard} />
    </SWRConfig>
  );

/** Hover the VA Bots button and wait for the robot rows. */
const openList = async () => {
  fireEvent.mouseEnter(await screen.findByTestId('titlebar-assistants'));
  await screen.findAllByTestId(/^robot-row-/);
};

beforeEach(() => {
  h.robots = [];
  h.hidden = [];
  for (const fn of [h.ensure, h.openPopup, h.setChatLocation, h.navigate, h.revealBrowserFor, h.openDashboard])
    fn.mockClear();
  h.conversations = {
    c1: { id: 'c1', name: 'Chat one', assistant: { id: 'bot-1', name: 'Research Bot' } },
    c2: { id: 'c2', name: 'Chat two', assistant: { id: 'bot-2', name: 'Sales Bot' } },
    c3: { id: 'c3', name: 'Chat three', assistant: { id: 'bot-3', name: 'Ops Bot' } },
  };
});

afterEach(() => cleanup());

describe('RobotListButton', () => {
  it('is the plain VA Bots button while there is no robot: a click opens the dashboard, hover lists nothing', async () => {
    renderButton();
    const button = await screen.findByLabelText('settings.assistants');
    fireEvent.mouseEnter(button);
    fireEvent.click(button);
    await act(async () => {});
    expect(h.openDashboard).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByTestId(/^robot-row-/)).toHaveLength(0);
  });

  it('clicking the button opens the dashboard even while robots are listed', async () => {
    h.robots = [{ conversation_id: 'c1', agent_id: 'bot-1', hidden: false }];
    renderButton();
    await openList();
    fireEvent.click(screen.getByTestId('titlebar-assistants'));
    expect(h.openDashboard).toHaveBeenCalledTimes(1);
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('shows no hidden badge while every robot is on the desktop', async () => {
    h.robots = [{ conversation_id: 'c1', agent_id: 'bot-1', hidden: false }];
    renderButton();
    await openList();
    expect(screen.getByTestId('titlebar-assistants').querySelector('.arco-badge-number')).toBeNull();
  });

  it('on hover lists every robot by bot name, tags hidden ones and counts them in the badge', async () => {
    h.robots = [
      { conversation_id: 'c1', agent_id: 'bot-1', hidden: false },
      { conversation_id: 'c2', agent_id: 'bot-2', hidden: true },
      { conversation_id: 'gone', agent_id: 'bot-9', hidden: true },
    ];
    renderButton();
    await openList();
    expect(screen.getByText('Research Bot')).toBeTruthy();
    expect(screen.getByText('Sales Bot')).toBeTruthy();
    expect(screen.queryByTestId('robot-row-gone')).toBeNull();
    expect(screen.getByTestId('robot-row-c2').textContent).toContain('pet.widget.hiddenTag');
    expect(screen.getByTestId('robot-row-c1').textContent).not.toContain('pet.widget.hiddenTag');
    expect(screen.getByTestId('titlebar-assistants').querySelector('.arco-badge-number')?.textContent).toBe('1');
    // A single hidden robot needs no "show all".
    expect(screen.queryByTestId('robots-show-all')).toBeNull();
  });

  it("marks each VA Bot robot with the bot's color, and nothing else", async () => {
    configService.setLocal('agent.colors', { 'bot-1': '#3e63dd', 'bot-2': '#3e63dd' });
    h.conversations.c1.assistant = { id: 'bot-1', name: 'Research Bot', source: 'user' };
    h.conversations.c2.assistant = { id: 'bot-2', name: 'Sales Bot', source: 'builtin' };
    h.robots = [
      { conversation_id: 'c1', agent_id: 'bot-1', hidden: false },
      { conversation_id: 'c2', agent_id: 'bot-2', hidden: false },
    ];
    renderButton();
    await openList();
    const dots = (id: string) =>
      Array.from(
        screen.getByTestId(`robot-row-${id}`).querySelectorAll<HTMLElement>('span[aria-hidden="true"]')
      ).filter((span) => span.style.backgroundColor === 'rgb(62, 99, 221)');
    expect(dots('c1')).toHaveLength(1);
    expect(dots('c2')).toHaveLength(0);
  });

  it('Watch opens the chat in the main window with its browser pane', async () => {
    h.robots = [{ conversation_id: 'c1', agent_id: 'bot-1', hidden: false }];
    renderButton();
    await openList();
    fireEvent.click(screen.getByLabelText('pet.widget.watchRobot'));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/conversation/c1'));
    expect(h.setChatLocation).toHaveBeenCalledWith({ conversation_id: 'c1', location: 'main' });
    expect(h.revealBrowserFor).toHaveBeenCalledWith('c1');
    expect(h.openPopup).not.toHaveBeenCalled();
  });

  it('clicking the row itself watches', async () => {
    h.robots = [{ conversation_id: 'c2', agent_id: 'bot-2', hidden: true }];
    renderButton();
    await openList();
    fireEvent.click(screen.getByText('Sales Bot'));
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith('/conversation/c2'));
    expect(h.revealBrowserFor).toHaveBeenCalledWith('c2');
  });

  it('Chat opens the robot popup on the desktop and does not navigate', async () => {
    h.robots = [{ conversation_id: 'c2', agent_id: 'bot-2', hidden: true }];
    renderButton();
    await openList();
    fireEvent.click(screen.getByLabelText('pet.widget.chatWithRobot'));
    await waitFor(() => expect(h.openPopup).toHaveBeenCalledWith({ conversation_id: 'c2', agent_id: 'bot-2' }));
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('opens on keyboard focus too, since a click navigates', async () => {
    h.robots = [{ conversation_id: 'c1', agent_id: 'bot-1', hidden: false }];
    renderButton();
    fireEvent.focus(await screen.findByTestId('titlebar-assistants'));
    expect(await screen.findByTestId('robot-row-c1')).toBeTruthy();
  });

  it('Enter on a row button acts only through that button, never as a row click', async () => {
    h.robots = [{ conversation_id: 'c1', agent_id: 'bot-1', hidden: false }];
    renderButton();
    await openList();
    // A real browser turns Enter on a button into its click; the keydown itself must not reach the row.
    fireEvent.keyDown(screen.getByLabelText('pet.widget.chatWithRobot'), { key: 'Enter', keyCode: 13 });
    fireEvent.keyDown(screen.getByLabelText('pet.widget.watchRobot'), { key: 'Enter', keyCode: 13 });
    await act(async () => {});
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.setChatLocation).not.toHaveBeenCalled();
  });

  it('"Show all" brings back every hidden robot only', async () => {
    h.robots = [
      { conversation_id: 'c1', agent_id: 'bot-1', hidden: false },
      { conversation_id: 'c2', agent_id: 'bot-2', hidden: true },
      { conversation_id: 'c3', agent_id: 'bot-3', hidden: true },
    ];
    renderButton();
    await openList();
    fireEvent.click(screen.getByTestId('robots-show-all'));
    await waitFor(() => expect(h.ensure).toHaveBeenCalledTimes(2));
    expect(h.ensure).toHaveBeenCalledWith({ conversation_id: 'c2', force: true, agent_id: 'bot-2' });
    expect(h.ensure).toHaveBeenCalledWith({ conversation_id: 'c3', force: true, agent_id: 'bot-3' });
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('drops the list, not the button, once the main process reports no robots', async () => {
    h.robots = [{ conversation_id: 'c1', agent_id: 'bot-1', hidden: false }];
    renderButton();
    await screen.findByTestId('titlebar-assistants');
    act(() => h.robotsListener?.([]));
    await waitFor(() => expect(screen.queryAllByTestId(/^robot-row-/)).toHaveLength(0));
    fireEvent.mouseEnter(screen.getByLabelText('settings.assistants'));
    await act(async () => {});
    expect(screen.queryAllByTestId(/^robot-row-/)).toHaveLength(0);
  });
});

describe('useRestoreHiddenAgentWidget', () => {
  it("opening a bot's chat shows its hidden robot again, even if hidden from another chat", async () => {
    h.hidden = [{ conversation_id: 'old-chat', agent_id: 'bot-1' }];
    renderHook(() => useRestoreHiddenAgentWidget('c1', 'bot-1'));
    await waitFor(() =>
      expect(h.ensure).toHaveBeenCalledWith({ conversation_id: 'c1', force: true, agent_id: 'bot-1' })
    );
  });

  it('leaves bots alone whose robot is not hidden', async () => {
    h.hidden = [{ conversation_id: 'c2', agent_id: 'bot-2' }];
    renderHook(() => useRestoreHiddenAgentWidget('c1', 'bot-1'));
    await act(async () => {});
    expect(h.ensure).not.toHaveBeenCalled();
  });
});
