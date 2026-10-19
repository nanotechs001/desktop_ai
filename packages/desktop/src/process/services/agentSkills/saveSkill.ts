/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SKILL_PROPOSAL_LIMITS,
  parseSkillProposal,
  type SaveSkillRequest,
  type SaveSkillResult,
  type SkillProposal,
} from '@/common/types/agent/skillProposal';

export type SkillSaverDeps = {
  getChatAgent(conversationId: string): Promise<{ agentId: string; name?: string; builtin: boolean } | null>;
  listSkillNames(): Promise<string[]>;
  importSkill(skillPath: string): Promise<{ skill_name: string }>;
  getEnabledSkills(agentId: string): Promise<string[]>;
  setEnabledSkills(agentId: string, skills: string[]): Promise<void>;
  makeTempDir(): Promise<string>;
  removeDir(dir: string): Promise<void>;
};

/** The frontmatter is written here, never taken from the draft; the description is JSON-quoted so YAML can't misread it. */
export const formatSkillMarkdown = ({ name, description, steps }: SkillProposal): string =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${steps}\n`;

const fail = (code: Extract<SaveSkillResult, { ok: false }>['code'], message: string): SaveSkillResult => ({
  ok: false,
  code,
  message,
});

export function createSkillSaver(deps: SkillSaverDeps): { save(req: SaveSkillRequest): Promise<SaveSkillResult> } {
  /** Successful saves per chat. */
  const saves = new Map<string, number>();

  const importFolder = async (proposal: SkillProposal): Promise<{ skill_name: string }> => {
    const tempDir = await deps.makeTempDir();
    try {
      const skillDir = path.join(tempDir, proposal.name);
      await fs.mkdir(skillDir);
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), formatSkillMarkdown(proposal), 'utf8');
      return await deps.importSkill(skillDir);
    } finally {
      await deps.removeDir(tempDir).catch((e) => console.warn('[agentSkills] could not remove temp folder', e));
    }
  };

  return {
    async save(req) {
      const { conversation_id: conversationId, ...draft } = req;
      const proposal = parseSkillProposal(draft);
      if (!proposal) return fail('invalid', 'The skill draft is not valid');

      const agent = await deps.getChatAgent(conversationId);
      if (!agent) return fail('no_agent', 'This chat has no Agent to save a skill for');

      if ((saves.get(conversationId) ?? 0) >= SKILL_PROPOSAL_LIMITS.savesPerChat)
        return fail('rate_limited', 'Too many skills saved in this chat');

      if ((await deps.listSkillNames()).includes(proposal.name))
        return fail('exists', `A skill named ${proposal.name} already exists`);

      let skillName: string;
      try {
        skillName = (await importFolder(proposal)).skill_name;
      } catch (error) {
        console.error('[agentSkills] import failed', error);
        return fail('import_failed', error instanceof Error ? error.message : 'Could not import the skill');
      }
      saves.set(conversationId, (saves.get(conversationId) ?? 0) + 1);

      // A built-in bot can't be edited, so the skill stays in the library only.
      if (agent.builtin) return { ok: true, skill_name: skillName, library_only: true };

      try {
        const enabled = await deps.getEnabledSkills(agent.agentId);
        if (!enabled.includes(skillName)) await deps.setEnabledSkills(agent.agentId, [...enabled, skillName]);
      } catch (error) {
        console.error('[agentSkills] could not enable the skill', error);
        return { ok: true, skill_name: skillName, agent_id: agent.agentId, enable_failed: true };
      }
      return { ok: true, skill_name: skillName, agent_id: agent.agentId, enabled_for: agent.name };
    },
  };
}
