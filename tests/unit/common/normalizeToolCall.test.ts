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
