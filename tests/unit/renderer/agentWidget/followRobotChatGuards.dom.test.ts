/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The main window never follows a robot's chat away from what the user is doing in it: a prompt typed on the home
 * page, or a text field they are typing in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: vi.fn(async (id: string) => ({ id, assistant: { id: 'bot-1', source: 'user' } })),
}));
vi.mock('@/common/config/configService', () => ({ configService: { get: vi.fn(() => undefined) } }));

import { followRobotChat } from '@/renderer/pages/agentWidget/useAgentWidgetSync';
import { setGuidDraftPresent } from '@/renderer/pages/guid/utils/guidDraftStore';

const deps = () => ({ revealBrowserFor: vi.fn(), navigate: vi.fn() });

beforeEach(() => {
  setGuidDraftPresent(false);
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('followRobotChat guards', () => {
  it('never leaves the home page while its prompt holds text', async () => {
    setGuidDraftPresent(true);
    const d = deps();
    await expect(followRobotChat('/guid', 'bot-b', d)).resolves.toBe(false);
    expect(d.navigate).not.toHaveBeenCalled();

    setGuidDraftPresent(false);
    await expect(followRobotChat('/guid', 'bot-b', d)).resolves.toBe(true);
  });

  it('stays put while the focused main window has a focused text field', async () => {
    const field = document.createElement('textarea');
    document.body.append(field);
    field.focus();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    const d = deps();
    await expect(followRobotChat('/conversation/bot-a', 'bot-b', d)).resolves.toBe(false);
    expect(d.navigate).not.toHaveBeenCalled();

    // The same focused field in a window the user left (they are in the robot popup) does not hold it back.
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await expect(followRobotChat('/conversation/bot-a', 'bot-b', d)).resolves.toBe(true);
  });
});
