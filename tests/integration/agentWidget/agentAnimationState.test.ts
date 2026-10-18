/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  applyStreamFrame,
  applyTurnCompleted,
  classifyTool,
  createActivity,
  DEFAULT_SLEEP_AFTER_MS,
  ERROR_HOLD_MS,
  resolveAnimationState,
  TALK_WINDOW_MS,
  type AgentActivity,
} from '@renderer/pages/agentWidget/agentAnimationState';

const T0 = 1_000_000;
const base = (patch: Partial<AgentActivity> = {}): AgentActivity => ({ ...createActivity(T0), ...patch });
const state = (a: AgentActivity, now = T0) => resolveAnimationState(a, now);

describe('priority policy: error > offline > listening > talking > searching > working > thinking > notification > sleeping > idle', () => {
  it('walks down the ladder one flag at a time', () => {
    const all = base({
      lastErrorAt: T0,
      offline: true,
      micActive: true,
      turnActive: true,
      lastTextAt: T0,
      tools: { a: 'search', b: 'work' },
      unread: true,
    });
    const ladder: Array<[Partial<AgentActivity>, string]> = [
      [{}, 'error'],
      [{ lastErrorAt: 0 }, 'offline'],
      [{ offline: false }, 'listening'],
      [{ micActive: false }, 'talking'],
      [{ lastTextAt: 0 }, 'searching'],
      [{ tools: { b: 'work' } }, 'working'],
      [{ tools: {} }, 'thinking'],
      [{ turnActive: false }, 'notification'],
      [{ unread: false }, 'idle'],
    ];
    let a = all;
    for (const [patch, expected] of ladder) {
      a = { ...a, ...patch };
      expect(state(a)).toBe(expected);
    }
  });

  it('times out of error, talking and into sleep', () => {
    expect(state(base({ lastErrorAt: T0 }), T0 + ERROR_HOLD_MS + 1)).toBe('idle');
    expect(state(base({ turnActive: true, lastTextAt: T0 }), T0 + TALK_WINDOW_MS + 1)).toBe('thinking');
    expect(state(base(), T0 + DEFAULT_SLEEP_AFTER_MS + 1)).toBe('sleeping');
  });
});

describe('stream frames → activity', () => {
  it('thinking, then text, then finish returns to idle', () => {
    let a = applyStreamFrame(base(), { type: 'thinking', data: {} }, T0);
    expect(state(a)).toBe('thinking');
    a = applyStreamFrame(a, { type: 'content', data: 'hi', position: 'left' }, T0);
    expect(state(a)).toBe('talking');
    a = applyStreamFrame(a, { type: 'finish', data: null }, T0);
    expect(state(a, T0 + 10)).toBe('idle');
  });

  it("ignores the user's own echoed text", () => {
    const a = applyStreamFrame(base(), { type: 'text', data: 'mine', position: 'right' }, T0);
    expect(a.turnActive).toBe(false);
  });

  it('ACP browser tool → searching until it completes; other tools → working', () => {
    const call = (status: string, title = 'browser_navigate') => ({
      type: 'acp_tool_call',
      data: { update: { tool_call_id: 'c1', status, title } },
    });
    let a = applyStreamFrame(base(), call('in_progress'), T0);
    expect(state(a)).toBe('searching');
    a = applyStreamFrame(a, call('completed'), T0);
    expect(a.tools).toEqual({});
    a = applyStreamFrame(a, call('pending', 'Edit file'), T0);
    expect(state(a)).toBe('working');
  });

  it('legacy tool_call and tool_group statuses', () => {
    let a = applyStreamFrame(
      base(),
      { type: 'tool_call', data: { call_id: 'x', name: 'web_search', status: 'running' } },
      T0
    );
    expect(state(a)).toBe('searching');
    a = applyStreamFrame(a, { type: 'tool_call', data: { call_id: 'x', name: 'web_search', status: 'completed' } }, T0);
    a = applyStreamFrame(
      a,
      { type: 'tool_group', data: [{ call_id: 'g', name: 'run_shell', status: 'Executing' }] },
      T0
    );
    expect(state(a)).toBe('working');
    a = applyStreamFrame(a, { type: 'tool_group', data: [{ call_id: 'g', name: 'run_shell', status: 'Success' }] }, T0);
    expect(a.tools).toEqual({});
  });

  it('error frames and agent error status hold the error pose', () => {
    expect(state(applyStreamFrame(base(), { type: 'error', data: 'boom' }, T0))).toBe('error');
    expect(state(applyStreamFrame(base(), { type: 'agent_status', data: { status: 'error' } }, T0))).toBe('error');
    expect(state(applyStreamFrame(base(), { type: 'agent_status', data: { status: 'connected' } }, T0))).toBe('idle');
  });

  it('classifies tools by name', () => {
    expect(classifyTool('mcp__chrome__navigate_page')).toBe('search');
    expect(classifyTool('Bash')).toBe('work');
    expect(classifyTool(undefined)).toBe('work');
  });
});

describe('turn completion', () => {
  const running = base({ turnActive: true, tools: { a: 'work' } });
  it('raises a notification only when the chat is not being looked at', () => {
    expect(state(applyTurnCompleted(running, { status: 'finished' }, false, T0))).toBe('notification');
    expect(state(applyTurnCompleted(running, { status: 'finished' }, true, T0))).toBe('idle');
  });
  it('a failed turn shows the error pose', () => {
    expect(state(applyTurnCompleted(running, { status: 'error' }, true, T0))).toBe('error');
  });
});
