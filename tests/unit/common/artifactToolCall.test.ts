import { describe, expect, it } from 'vitest';
import {
  detectBuiltinToolCards,
  parseArtifactToolCall,
  parseMemorySaveToolCall,
  parseNoteToolCall,
  parseSkillProposalToolCall,
} from '@/common/chat/artifactToolCall';

const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const url = `http://127.0.0.1:4300/a/${ID}`;
const result = JSON.stringify({ id: ID, version: 2, url });

describe('parseArtifactToolCall', () => {
  it.each([
    'mcp__aionui-artifacts__create',
    'mcp__aionui-artifacts__update',
    'aionui-artifacts.create',
    'aionui-artifacts - update (MCP)',
  ])('recognises %s and reads title and kind from the input', (name) => {
    expect(parseArtifactToolCall(name, { title: 'Report', kind: 'html' }, result)).toEqual({
      title: 'Report',
      kind: 'html',
      version: 2,
      url,
    });
  });

  it('recognises a bare create/update when the server field names the artifacts server', () => {
    expect(parseArtifactToolCall('create', undefined, result, 'aionui-artifacts')).toMatchObject({ version: 2, url });
    expect(parseArtifactToolCall('create', undefined, result, 'other')).toBeUndefined();
    expect(parseArtifactToolCall('create', undefined, result)).toBeUndefined();
  });

  it('ignores get and other servers', () => {
    expect(parseArtifactToolCall('mcp__aionui-artifacts__get', {}, result)).toBeUndefined();
    expect(parseArtifactToolCall('mcp__aionui-browser__create', {}, result)).toBeUndefined();
    expect(parseArtifactToolCall('mcp__evil-aionui-artifacts__create', {}, result)).toBeUndefined();
  });

  it.each([undefined, '', 'not json', '{"id":"x"}', '{"id":"x","version":"2","url":"u"}', '[]', 'null'])(
    'returns nothing for the missing or malformed result %j',
    (output) => {
      expect(parseArtifactToolCall('mcp__aionui-artifacts__create', { title: 'T' }, output)).toBeUndefined();
    }
  );

  it('leaves title and kind out when the input does not carry strings', () => {
    expect(parseArtifactToolCall('mcp__aionui-artifacts__update', { title: 3 }, result)).toEqual({ version: 2, url });
  });

  it('reads title and kind from an input that arrives as a JSON string (tool_group)', () => {
    expect(parseArtifactToolCall('mcp__aionui-artifacts__create', '{"title":"T","kind":"svg"}', result)).toEqual({
      title: 'T',
      kind: 'svg',
      version: 2,
      url,
    });
    expect(parseArtifactToolCall('mcp__aionui-artifacts__create', 'plain description', result)).toMatchObject({
      version: 2,
    });
  });
});

describe('parseNoteToolCall', () => {
  const saved = JSON.stringify({ id: 'n1', saved: true, text: 'Prefers metric units', source: 'agent' });

  it.each(['mcp__aionui-notes__add', 'aionui-notes.add', 'aionui-notes - add (MCP)'])(
    'reads the saved note of %s from its JSON result',
    (name) => {
      expect(parseNoteToolCall(name, saved)).toEqual({ text: 'Prefers metric units', source: 'agent' });
    }
  );

  it('recognises a bare add when the server field names the notes server', () => {
    expect(parseNoteToolCall('add', saved, 'aionui-notes')).toMatchObject({ text: 'Prefers metric units' });
    expect(parseNoteToolCall('add', saved, 'other')).toBeUndefined();
  });

  it('keeps a page note marked as from a page', () => {
    const page = JSON.stringify({ id: 'n2', saved: true, text: 'Login is at /signin', source: 'page' });
    expect(parseNoteToolCall('mcp__aionui-notes__add', page)).toEqual({ text: 'Login is at /signin', source: 'page' });
  });

  it.each([
    ['an error text', 'A chat saves at most 10 notes'],
    ['an unsaved result', JSON.stringify({ saved: false, text: 'x', source: 'agent' })],
    ['an unknown source', JSON.stringify({ saved: true, text: 'x', source: 'user' })],
    ['a missing text', JSON.stringify({ saved: true, source: 'agent' })],
    ['no output', undefined],
  ])('ignores %s', (_label, output) => {
    expect(parseNoteToolCall('mcp__aionui-notes__add', output)).toBeUndefined();
  });

  it('ignores other tools and servers', () => {
    expect(parseNoteToolCall('mcp__aionui-artifacts__create', saved)).toBeUndefined();
    expect(parseNoteToolCall('mcp__other-notes__add', saved)).toBeUndefined();
  });
});

describe('parseMemorySaveToolCall', () => {
  const result = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      saved: true,
      action: 'created',
      scope: 'own',
      id: 'm1',
      version: 'v1',
      title: 'Client',
      ...extra,
    });

  it.each(['mcp__aionui-notes__memory_save', 'aionui-notes.memory_save', 'aionui-notes - memory_save (MCP)'])(
    'reads what %s remembered from its JSON result',
    (name) => {
      expect(parseMemorySaveToolCall(name, result())).toEqual({
        kind: 'memory',
        action: 'created',
        scope: 'own',
        title: 'Client',
      });
    }
  );

  it.each(['updated', 'superseded'] as const)('keeps the %s action and a shared scope', (action) => {
    expect(parseMemorySaveToolCall('mcp__aionui-notes__memory_save', result({ action, scope: 'shared' }))).toEqual({
      kind: 'memory',
      action,
      scope: 'shared',
      title: 'Client',
    });
  });

  it('recognises a bare memory_save when the server field names the notes server', () => {
    expect(parseMemorySaveToolCall('memory_save', result(), 'aionui-notes')).toMatchObject({ title: 'Client' });
    expect(parseMemorySaveToolCall('memory_save', result(), 'other')).toBeUndefined();
  });

  it.each([
    ['an error text', 'A chat saves at most 30 notes'],
    ['an unsaved result', result({ saved: false })],
    ['an unknown action', result({ action: 'deleted' })],
    ['an unknown scope', result({ scope: 'everyone' })],
    ['a missing title', result({ title: '' })],
    ['a missing id', result({ id: undefined })],
    ['no output', undefined],
  ])('ignores %s', (_label, output) => {
    expect(parseMemorySaveToolCall('mcp__aionui-notes__memory_save', output)).toBeUndefined();
  });

  it('ignores other tools and servers', () => {
    expect(parseMemorySaveToolCall('mcp__aionui-notes__add', result())).toBeUndefined();
    expect(parseMemorySaveToolCall('mcp__other-notes__memory_save', result())).toBeUndefined();
  });

  it('is what a memory_save call shows, by name or by a wrapped call that names the tool', () => {
    expect(detectBuiltinToolCards('mcp__aionui-notes__memory_save', {}, result()).note).toMatchObject({
      kind: 'memory',
    });
    expect(detectBuiltinToolCards('execute', {}, result(), undefined, { script: 'memory_save(x)' }).note).toMatchObject(
      { kind: 'memory', title: 'Client' }
    );
    expect(detectBuiltinToolCards('execute', {}, result(), undefined, { script: 'other' }).note).toBeUndefined();
  });

  it('still shows an old notebook save as a notebook note', () => {
    const old = JSON.stringify({ id: 'n1', saved: true, text: 'Prefers metric units', source: 'agent' });
    expect(detectBuiltinToolCards('mcp__aionui-notes__add', {}, old).note).toEqual({
      text: 'Prefers metric units',
      source: 'agent',
    });
  });
});

describe('parseSkillProposalToolCall', () => {
  const draft = {
    name: 'weekly-report',
    description: 'Use when the user asks for the weekly report',
    steps: '1. Open the dashboard\n2. Export the numbers',
  };
  const ok = JSON.stringify({ proposed: true, name: 'weekly-report', status: 'shown' });

  it.each(['mcp__aionui-notes__propose_skill', 'aionui-notes.propose_skill', 'aionui-notes - propose_skill (MCP)'])(
    'reads a %s call',
    (name) => {
      expect(parseSkillProposalToolCall(name, draft, ok)).toEqual(draft);
    }
  );

  it('reads a bare propose_skill with the notes server field', () => {
    expect(parseSkillProposalToolCall('propose_skill', draft, ok, 'aionui-notes')).toEqual(draft);
    expect(parseSkillProposalToolCall('propose_skill', draft, ok, 'other')).toBeUndefined();
    expect(parseSkillProposalToolCall('propose_skill', draft, ok)).toBeUndefined();
  });

  it('reads a JSON-string input', () => {
    expect(parseSkillProposalToolCall('mcp__aionui-notes__propose_skill', JSON.stringify(draft), ok)).toEqual(draft);
  });

  it('returns undefined for an error result, an invalid draft and other tools', () => {
    const name = 'mcp__aionui-notes__propose_skill';
    expect(parseSkillProposalToolCall(name, draft, JSON.stringify({ isError: true }))).toBeUndefined();
    expect(parseSkillProposalToolCall(name, { ...draft, name: 'Bad Name' }, ok)).toBeUndefined();
    expect(parseSkillProposalToolCall(name, 'not json', ok)).toBeUndefined();
    expect(parseSkillProposalToolCall('mcp__aionui-notes__add', draft, ok)).toBeUndefined();
  });
});
