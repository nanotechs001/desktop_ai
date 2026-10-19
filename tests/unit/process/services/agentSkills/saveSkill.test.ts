/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SKILL_PROPOSAL_LIMITS, parseSkillProposal, type SkillProposal } from '@/common/types/agent/skillProposal';
import { createSkillSaver, formatSkillMarkdown, type SkillSaverDeps } from '@process/services/agentSkills/saveSkill';

const draft: SkillProposal = {
  name: 'weekly-report',
  description: 'Builds the weekly report from the sales sheet and mails it to the team.',
  steps: '1. Open the sheet.\n2. Summarise it.',
};

let tmpRoot: string;
let imported: { path: string; markdown: string }[];
let deps: SkillSaverDeps;
let setEnabledSkills: ReturnType<typeof vi.fn>;
let makeTempDir: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'save-skill-test-'));
  imported = [];
  setEnabledSkills = vi.fn(async () => {});
  makeTempDir = vi.fn(async () => fs.mkdtemp(path.join(tmpRoot, 'run-')));
  deps = {
    getChatAgent: async () => ({ agentId: 'bot-1', name: 'Research Bot', builtin: false }),
    listSkillNames: async () => ['other-skill'],
    importSkill: async (skillPath) => {
      imported.push({ path: skillPath, markdown: await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8') });
      return { skill_name: path.basename(skillPath) };
    },
    getEnabledSkills: async () => ['existing'],
    setEnabledSkills,
    makeTempDir,
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
  };
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const save = (override: Partial<SkillProposal> = {}, d: SkillSaverDeps = deps, conversation_id = 'c1') =>
  createSkillSaver(d).save({ conversation_id, ...draft, ...override });

describe('createSkillSaver', () => {
  it('writes SKILL.md with code-written frontmatter, imports the folder and enables it on the bot', async () => {
    const result = await save();

    expect(result).toEqual({ ok: true, skill_name: 'weekly-report', agent_id: 'bot-1', enabled_for: 'Research Bot' });
    expect(imported).toHaveLength(1);
    expect(path.basename(imported[0].path)).toBe('weekly-report');
    expect(path.dirname(imported[0].path).startsWith(tmpRoot)).toBe(true);
    expect(imported[0].markdown).toBe(formatSkillMarkdown(draft));
    expect(setEnabledSkills).toHaveBeenCalledWith('bot-1', ['existing', 'weekly-report']);
  });

  it('keeps the frontmatter intact when steps contain --- and name: lines', async () => {
    await save({ steps: '---\nname: evil\n---\nbody' });

    const firstBlock = imported[0].markdown.split('---')[1];
    expect(firstBlock).toContain('name: weekly-report');
    expect(firstBlock).not.toContain('evil');
  });

  it('quotes the description so YAML cannot misread it', () => {
    const md = formatSkillMarkdown({ ...draft, description: 'Note: a "quoted" thing # not a comment' });
    expect(md).toContain('description: "Note: a \\"quoted\\" thing # not a comment"\n');
  });

  it('returns exists for a name already in the library', async () => {
    const result = await save({}, { ...deps, listSkillNames: async () => ['weekly-report'] });

    expect(result).toMatchObject({ ok: false, code: 'exists' });
    expect(makeTempDir).not.toHaveBeenCalled();
  });

  it('removes the temp folder when the import fails, and does not enable', async () => {
    let tempDir = '';
    const result = await save(
      {},
      {
        ...deps,
        makeTempDir: async () => (tempDir = await fs.mkdtemp(path.join(tmpRoot, 'run-'))),
        importSkill: async () => {
          throw new Error('boom');
        },
      }
    );

    expect(result).toMatchObject({ ok: false, code: 'import_failed' });
    await expect(fs.access(tempDir)).rejects.toThrow();
    expect(setEnabledSkills).not.toHaveBeenCalled();
  });

  it('keeps the skill and reports enable_failed when enabling fails', async () => {
    setEnabledSkills.mockRejectedValue(new Error('nope'));

    const result = await save();

    expect(result).toEqual({ ok: true, skill_name: 'weekly-report', agent_id: 'bot-1', enable_failed: true });
  });

  it('saves to the library only for a built-in bot', async () => {
    const result = await save(
      {},
      { ...deps, getChatAgent: async () => ({ agentId: 'builtin-x', name: 'Built-in', builtin: true }) }
    );

    expect(result).toEqual({ ok: true, skill_name: 'weekly-report', library_only: true });
    expect(setEnabledSkills).not.toHaveBeenCalled();
  });

  it('refuses the 11th save in one chat', async () => {
    const saver = createSkillSaver(deps);
    for (let i = 0; i < SKILL_PROPOSAL_LIMITS.savesPerChat; i++) {
      const r = await saver.save({ conversation_id: 'c1', ...draft, name: `skill-${i}` });
      expect(r.ok).toBe(true);
    }

    const result = await saver.save({ conversation_id: 'c1', ...draft, name: 'one-too-many' });
    expect(result).toMatchObject({ ok: false, code: 'rate_limited' });

    const other = await saver.save({ conversation_id: 'c2', ...draft, name: 'other-chat' });
    expect(other.ok).toBe(true);
  });

  it('rejects an invalid draft without touching the disk', async () => {
    const result = await save({ name: 'Bad Name' });

    expect(result).toMatchObject({ ok: false, code: 'invalid' });
    expect(makeTempDir).not.toHaveBeenCalled();
  });

  it('returns no_agent when the chat has no Agent', async () => {
    const result = await save({}, { ...deps, getChatAgent: async () => null });

    expect(result).toMatchObject({ ok: false, code: 'no_agent' });
    expect(makeTempDir).not.toHaveBeenCalled();
  });

  it('does not add a duplicate when the bot already has the skill enabled', async () => {
    const result = await save({}, { ...deps, getEnabledSkills: async () => ['existing', 'weekly-report'] });

    expect(result).toMatchObject({ ok: true, enabled_for: 'Research Bot' });
    expect(setEnabledSkills).not.toHaveBeenCalled();
  });
});

describe('parseSkillProposal', () => {
  it('rejects an extra key, so a draft cannot smuggle frontmatter fields', () => {
    expect(parseSkillProposal({ ...draft, license: 'x' })).toBeUndefined();
  });
});
