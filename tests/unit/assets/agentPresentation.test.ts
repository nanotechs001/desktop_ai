/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Robot } from '@icon-park/react';
import type { TFunction } from 'i18next';
import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import type { PresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { agentFromPresetInfo, getAgentPresentation } from '@/renderer/utils/ui/agentPresentation';

const t = ((key: string) => (key === 'agent.displayName' ? 'Agent' : key)) as TFunction;

describe('getAgentPresentation', () => {
  it('returns "Agent" and the robot icon regardless of backend', () => {
    for (const backend of ['claude', 'codex', 'gemini', 'aionrs']) {
      // A vendor-derived identity must never reach the helper as a name.
      const presentation = getAgentPresentation(agentFromPresetInfo({ ...engineInfo, backend }), t);

      expect(presentation.name).toBe('Agent');
      expect(isValidElement(presentation.avatar)).toBe(true);
      expect((presentation.avatar as ReactElement).type).toBe(Robot);
    }
  });

  it('falls back to "Agent" and the robot icon when there is no agent or no name', () => {
    for (const agent of [null, {}, { name: '  ', avatar: '' }]) {
      const presentation = getAgentPresentation(agent, t);

      expect(presentation.name).toBe('Agent');
      expect((presentation.avatar as ReactElement).type).toBe(Robot);
    }
  });

  it("shows the user-made Agent's name and emoji avatar", () => {
    const presentation = getAgentPresentation({ name: 'Research Agent', avatar: '🔬' }, t);

    expect(presentation.name).toBe('Research Agent');
    expect((presentation.avatar as ReactElement<{ children: string }>).props.children).toBe('🔬');
  });

  it("renders the user-made Agent's image avatar", () => {
    const presentation = getAgentPresentation({ name: 'Writer', avatar: 'https://example.test/writer.png' }, t);

    expect((presentation.avatar as ReactElement<{ src: string }>).props.src).toBe('https://example.test/writer.png');
  });

  it('sizes the avatar to the requested pixels', () => {
    const robot = getAgentPresentation(null, t, 32).avatar as ReactElement<{ size: number }>;
    const emoji = getAgentPresentation({ avatar: '🔬' }, t, 32).avatar as ReactElement<{ style: { fontSize: number } }>;
    const image = getAgentPresentation({ avatar: 'https://example.test/a.png' }, t, 32).avatar as ReactElement<{
      style: { width: number; height: number };
    }>;

    expect(robot.props.size).toBe(32);
    expect(emoji.props.style.fontSize).toBe(28);
    expect(image.props.style).toEqual({ width: 32, height: 32 });
  });
});

// Shape of the identity usePresetAssistantInfo builds from `extra.agent_name` / `extra.backend`.
const engineInfo: PresetAssistantInfo = { name: 'Claude Code', logo: '', isEmoji: false, backend: 'claude' };

describe('agentFromPresetInfo', () => {
  it('returns the name and avatar of an assistant record', () => {
    const info: PresetAssistantInfo = {
      name: 'Research Agent',
      logo: '🔬',
      isEmoji: true,
      backend: 'claude',
      assistantId: 'a1',
    };

    expect(agentFromPresetInfo(info)).toEqual({ name: 'Research Agent', avatar: '🔬' });
  });

  it("drops an engine's own generated entry: its record carries the vendor name and logo", () => {
    const bare: PresetAssistantInfo = {
      name: 'Claude Code',
      logo: '/api/assets/logos/ai-major/claude.svg',
      isEmoji: false,
      backend: 'claude',
      assistantId: 'bare:2d23ff1c',
      source: 'generated',
    };

    expect(agentFromPresetInfo(bare)).toBeNull();
  });

  it('drops identities derived from the engine instead of an assistant record', () => {
    expect(agentFromPresetInfo(engineInfo)).toBeNull();
    expect(agentFromPresetInfo(null)).toBeNull();
  });
});
