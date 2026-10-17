/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TFunction } from 'i18next';
import type { TChatConversation } from '@/common/config/storage';
import { resolveConversationLeadingMark } from '@/renderer/pages/conversation/utils/conversationAssistantIdentity';
import { describe, expect, it } from 'vitest';

const t = ((key: string) => (key === 'agent.displayName' ? 'Agent' : key)) as TFunction;

describe('resolveConversationLeadingMark', () => {
  it('prefers the assistant image avatar when assistant info exists', () => {
    const result = resolveConversationLeadingMark(
      makeConversation(),
      {
        name: 'Academic Paper',
        logo: '/api/assistants/academic-paper/avatar',
        isEmoji: false,
        backend: 'claude',
        assistantId: 'academic-paper',
      },
      t
    );

    expect(result).toEqual({
      kind: 'image',
      value: '/api/assistants/academic-paper/avatar',
      label: 'Academic Paper',
    });
  });

  it('prefers the assistant emoji avatar when assistant info exists', () => {
    const result = resolveConversationLeadingMark(
      makeConversation(),
      {
        name: 'Academic Paper',
        logo: '📚',
        isEmoji: true,
        backend: 'claude',
        assistantId: 'academic-paper',
      },
      t
    );

    expect(result).toEqual({
      kind: 'emoji',
      value: '📚',
      label: 'Academic Paper',
    });
  });

  it('uses the conversation assistant snapshot when no assistant info is resolved', () => {
    const result = resolveConversationLeadingMark(
      makeConversation({ assistant: { id: 'writer', name: 'Writer', avatar: '✍️', backend: 'claude' } }),
      undefined,
      t
    );

    expect(result).toEqual({ kind: 'emoji', value: '✍️', label: 'Writer' });
  });

  it("shows the neutral Agent mark for a chat on an engine's own generated entry", () => {
    const conversation = makeConversation({
      assistant: {
        id: 'bare:2d23ff1c',
        source: 'generated',
        name: 'Claude Code',
        avatar: '/api/assets/logos/ai-major/claude.svg',
        backend: 'claude',
      },
    });

    expect(resolveConversationLeadingMark(conversation, undefined, t)).toEqual({
      kind: 'assistant_fallback',
      label: 'Agent',
    });
  });

  it.each(['claude', 'codex', 'gemini', 'unknown-agent'])(
    'shows the neutral Agent mark, never the %s engine logo, when the chat has no Agent record',
    (backend) => {
      const result = resolveConversationLeadingMark(makeConversation({}, { backend }), undefined, t);

      expect(result).toEqual({ kind: 'assistant_fallback', label: 'Agent' });
    }
  );

  it('ignores an identity derived from the engine instead of an assistant record', () => {
    const result = resolveConversationLeadingMark(
      makeConversation(),
      { name: 'Claude Code', logo: '/api/assets/logos/claude.svg', isEmoji: false, backend: 'claude' },
      t
    );

    expect(result).toEqual({ kind: 'assistant_fallback', label: 'Agent' });
  });
});

function makeConversation(
  overrides: Partial<TChatConversation> = {},
  extraOverrides: Record<string, unknown> = {}
): TChatConversation {
  return {
    id: 'conversation-1',
    name: 'Conversation 1',
    type: 'acp',
    assistant: undefined,
    created_at: Date.now(),
    updated_at: Date.now(),
    source: 'chat',
    index: 0,
    is_favorite: false,
    extra: {
      backend: 'claude',
      ...extraOverrides,
      ...overrides.extra,
    },
    ...overrides,
  } as TChatConversation;
}
