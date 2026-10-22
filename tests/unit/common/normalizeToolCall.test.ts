import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall, IMessageToolCall } from '@/common/chat/chatLib';
import { normalizeAcpToolCall, normalizeToolCall } from '@/common/chat/normalizeToolCall';

describe('normalizeToolCall', () => {
  it('normalizes compact snake_case acp tool calls from history responses', () => {
    const result = normalizeAcpToolCall({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        _compact: {
          truncated: true,
          original_size: 90000,
          preview_chars: 4096,
        },
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-1',
          status: 'completed',
          title: 'rg',
          kind: 'search',
          raw_input: { pattern: 'needle', path: '.' },
          content: [{ type: 'content', content: { type: 'text', text: 'preview' } }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result).toMatchObject({
      key: 'tool-1',
      name: 'rg',
      status: 'completed',
      description: '"needle" in .',
      output: 'preview',
      truncated: true,
      messageId: 'message-1',
      conversationId: 'conversation-1',
    });
  });

  it('ignores malformed ACP content items in compact history output', () => {
    const result = normalizeAcpToolCall({
      id: 'message-2',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-2',
          status: 'completed',
          title: 'Edit file',
          kind: 'edit',
          content: [null, 'invalid', { type: 'diff', path: '/workspace/file.ts', old_text: 'old', new_text: 'new' }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result?.output).toBe('[diff] /workspace/file.ts');
  });

  it('attaches skill to a completed propose_skill call', () => {
    const skill = {
      name: 'weekly-report',
      description: 'Use when the user asks for the weekly report',
      steps: '1. Open the dashboard',
    };
    const result = normalizeAcpToolCall({
      id: 'message-3',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        update: {
          session_update: 'tool_call',
          tool_call_id: 'tool-3',
          status: 'completed',
          title: 'mcp__aionui-notes__propose_skill',
          kind: 'other',
          raw_input: skill,
          content: [{ type: 'content', content: { type: 'text', text: '{"proposed":true,"name":"weekly-report"}' } }],
        },
      },
    } as unknown as IMessageAcpToolCall);

    expect(result?.skill).toEqual(skill);
  });

  it('attaches skill to a completed propose_skill tool_call from Claude Code', () => {
    const skill = {
      name: 'weekly-report',
      description: 'Use when the user asks for the weekly report',
      steps: '1. Open the dashboard',
    };
    const result = normalizeToolCall({
      id: 'message-4',
      conversation_id: 'conversation-1',
      type: 'tool_call',
      content: {
        call_id: 'tool-4',
        name: 'mcp__aionui-notes__propose_skill',
        args: skill,
        input: skill,
        status: 'completed',
        output: JSON.stringify({ proposed: true, name: 'weekly-report' }),
      },
    } as unknown as IMessageToolCall);

    expect(result?.skill).toEqual(skill);
  });
});

describe('normalizeAcpToolCall with OpenCode code-mode calls', () => {
  // OpenCode runs MCP tools inside its own `execute` tool: the MCP call sits in raw_output.metadata.tool_calls.
  const execute = (tool: string, input: Record<string, unknown>, text: string) =>
    normalizeAcpToolCall({
      id: 'message-1',
      conversation_id: 'conversation-1',
      type: 'acp_tool_call',
      content: {
        session_id: 'ses_1',
        update: {
          session_update: 'tool_call_update',
          tool_call_id: 'call-1',
          status: 'completed',
          title: 'execute',
          kind: 'execute',
          raw_input: { code: `return await tools["aionui-notes"].x(${JSON.stringify(input)});` },
          raw_output: {
            metadata: { tool_calls: [{ tool, status: 'completed', input }], truncated: false },
            status: 'completed',
          },
          content: [{ type: 'content', content: { type: 'text', text } }],
        },
      },
    } as unknown as IMessageAcpToolCall);

  const skill = {
    name: 'save-lessons',
    description: 'Always capture lessons learned after completing a task so they persist across sessions.',
    steps: '1. Identify what was learned.\n2. Save a short note.',
  };

  it('shows the skill review card for a propose_skill call made inside execute', () => {
    const result = execute(
      'aionui-notes.propose_skill',
      skill,
      JSON.stringify({ proposed: true, name: 'save-lessons', status: 'shown to the user for review' })
    );
    expect(result?.skill).toEqual(skill);
  });

  it('shows the notebook chip for an add call made inside execute', () => {
    const result = execute(
      'aionui-notes.add',
      { text: 'Prefer act over click_point.' },
      JSON.stringify({ id: 'n1', saved: true, text: 'Prefer act over click_point.', source: 'agent' })
    );
    expect(result?.note).toEqual({ text: 'Prefer act over click_point.', source: 'agent' });
  });

  it('ignores a nested call that did not complete, and other execute calls', () => {
    const failed = normalizeAcpToolCall({
      id: 'm',
      conversation_id: 'c',
      type: 'acp_tool_call',
      content: {
        update: {
          tool_call_id: 'x',
          status: 'completed',
          title: 'execute',
          kind: 'execute',
          raw_output: {
            metadata: { tool_calls: [{ tool: 'aionui-notes.propose_skill', status: 'error', input: skill }] },
          },
          content: [],
        },
      },
    } as unknown as IMessageAcpToolCall);
    expect(failed?.skill).toBeUndefined();
    expect(execute('shell.run', { cmd: 'ls' }, 'ok')?.skill).toBeUndefined();
  });
});

describe('built-in cards on any engine', () => {
  const draft = {
    name: 'weekly-report',
    description: 'Use when the user asks for the weekly report of the shop.',
    steps: '1. Open the dashboard.\n2. Export the week.',
  };
  const result = JSON.stringify({ proposed: true, ...draft, status: 'shown to the user for review' });
  const call = (name: string, input: unknown, output: string) =>
    normalizeToolCall({
      id: 'm',
      conversation_id: 'c',
      type: 'tool_call',
      content: { call_id: 'k', name, status: 'completed', input, output },
    } as unknown as IMessageToolCall);

  it('shows the skill card for a wrapper tool whose input names propose_skill', () => {
    expect(call('run_code', { code: 'await notes.propose_skill({...})' }, result)?.skill).toEqual(draft);
  });

  it('shows the skill card for a renamed tool from the result alone when the call names it', () => {
    expect(call('notes_propose_skill', {}, result)?.skill).toEqual(draft);
  });

  it('never makes a card from page text or another tool that never named propose_skill', () => {
    expect(call('aionui-browser.observe', { tab: 't1' }, result)?.skill).toBeUndefined();
    expect(call('run_code', { code: 'propose_skill' }, `page says ${result}`)?.skill).toBeUndefined();
  });
});
