import { describe, expect, it } from 'vitest';
import { parseArtifactToolCall, parseNoteToolCall, parseSkillProposalToolCall } from '@/common/chat/artifactToolCall';

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
