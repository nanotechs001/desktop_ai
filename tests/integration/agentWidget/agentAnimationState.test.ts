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
  advanceRestCycle,
  AWAKE_SPELL_MS,
  NAP_MS,
  type AgentActivity,
  type RestCycle,
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

// An idle robot naps and wakes on its own: asleep for a random NAP_MS, awake for a random AWAKE_SPELL_MS, repeating,
// instead of sleeping until the next real activity.
describe('nap-and-wake rest cycle', () => {
  const idleFor = (ms: number) => T0 + ms;
  const sleepAt = idleFor(DEFAULT_SLEEP_AFTER_MS + 1);
  const fixed = (value: number) => () => value;
  const advance = (cycle: RestCycle | null, now: number, random = fixed(0)) => advanceRestCycle(cycle, T0, now, random);

  it('has no cycle before the robot has been idle long enough to sleep', () => {
    expect(advance(null, idleFor(DEFAULT_SLEEP_AFTER_MS))).toBeNull();
  });

  it('falls asleep after the idle timeout for a nap inside NAP_MS', () => {
    const shortest = advance(null, sleepAt, fixed(0));
    const longest = advance(null, sleepAt, fixed(0.999999));
    expect(shortest).toEqual({ asleep: true, until: sleepAt + NAP_MS[0] });
    expect(longest?.asleep).toBe(true);
    expect(longest!.until - sleepAt).toBeLessThanOrEqual(NAP_MS[1]);
    expect(longest!.until - sleepAt).toBeGreaterThan(NAP_MS[1] - 1000);
  });

  it('wakes by itself when the nap ends, for an awake spell inside AWAKE_SPELL_MS, then naps again', () => {
    const nap = advance(null, sleepAt);
    expect(advance(nap, nap!.until - 1)).toBe(nap);
    const awake = advance(nap, nap!.until, fixed(0.5));
    expect(awake).toEqual({
      asleep: false,
      until: nap!.until + AWAKE_SPELL_MS[0] + Math.floor(0.5 * (AWAKE_SPELL_MS[1] - AWAKE_SPELL_MS[0])),
    });
    const napAgain = advance(awake, awake!.until);
    expect(napAgain).toEqual({ asleep: true, until: awake!.until + NAP_MS[0] });
  });

  it('real activity ends the cycle: the robot is awake and the idle countdown starts over', () => {
    const nap = advance(null, sleepAt);
    const afterActivity = advanceRestCycle(nap, sleepAt + 10, sleepAt + 20, fixed(0));
    expect(afterActivity).toBeNull();
  });

  it('drives the animation: sleeping during a nap, idle during an awake spell, idle with no cycle', () => {
    const idle = base();
    expect(resolveAnimationState(idle, sleepAt, DEFAULT_SLEEP_AFTER_MS, { asleep: true, until: sleepAt + 1 })).toBe(
      'sleeping'
    );
    expect(resolveAnimationState(idle, sleepAt, DEFAULT_SLEEP_AFTER_MS, { asleep: false, until: sleepAt + 1 })).toBe(
      'idle'
    );
    expect(resolveAnimationState(idle, sleepAt, DEFAULT_SLEEP_AFTER_MS, null)).toBe('idle');
  });

  it('never outranks real states: a nap still yields to thinking or an unread reply', () => {
    const nap: RestCycle = { asleep: true, until: sleepAt + 1 };
    expect(resolveAnimationState(base({ turnActive: true }), sleepAt, DEFAULT_SLEEP_AFTER_MS, nap)).toBe('thinking');
    expect(resolveAnimationState(base({ unread: true }), sleepAt, DEFAULT_SLEEP_AFTER_MS, nap)).toBe('notification');
  });
});
