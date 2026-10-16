import { describe, expect, it } from 'vitest';
import { parseArtifactToolCall } from '@/common/chat/artifactToolCall';

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
});
