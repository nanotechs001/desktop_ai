/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { IMessageAcpToolCall, IMessageToolCall, IMessageToolGroup } from '@/common/chat/chatLib';
import {
  collectTurnFiles,
  extractToolFileTargets,
  extractWrittenFilesFromCommand,
  isPreviewableDocumentPath,
} from '@/renderer/pages/conversation/Messages/fileLinks/toolFilePaths';

type AcpUpdate = IMessageAcpToolCall['content']['update'];

const acp = (id: string, update: Partial<AcpUpdate>): IMessageAcpToolCall => ({
  id,
  conversation_id: 'c1',
  type: 'acp_tool_call',
  content: {
    sessionId: 's1',
    update: {
      sessionUpdate: 'tool_call_update',
      tool_call_id: id,
      status: 'completed',
      title: 'Tool',
      kind: 'edit',
      ...update,
    },
  },
});

describe('isPreviewableDocumentPath', () => {
  it('accepts the document extensions case-insensitively', () => {
    for (const path of ['a.html', 'a.HTM', 'b.Docx', 'c.pptx', 'd.XLSX', 'e.pdf', 'f.md']) {
      expect(isPreviewableDocumentPath(path)).toBe(true);
    }
  });

  it('rejects code, images, csv, legacy office and extensionless names', () => {
    for (const path of ['a.ts', 'b.png', 'c.csv', 'd.doc', 'Makefile', '.md', 'dir.md/file']) {
      expect(isPreviewableDocumentPath(path)).toBe(false);
    }
  });
});

describe('extractToolFileTargets — ACP', () => {
  it('reads edit locations, rawInput and diff paths', () => {
    const fromLocation = acp('t1', { locations: [{ path: '/ws/report.html' }] });
    const fromRawInput = acp('t2', { rawInput: { file_path: 'C:\\ws\\notes.md' } });
    const fromDiff = acp('t3', { content: [{ type: 'diff', path: 'docs/plan.md', old_text: null, new_text: '# x' }] });

    expect(extractToolFileTargets(fromLocation)).toEqual([{ path: '/ws/report.html', toolKey: 't1', completed: true }]);
    expect(extractToolFileTargets(fromRawInput).map((t) => t.path)).toEqual(['C:\\ws\\notes.md']);
    expect(extractToolFileTargets(fromDiff).map((t) => t.path)).toEqual(['docs/plan.md']);
  });

  it('accepts the snake_case raw_input variant', () => {
    const message = acp('t1', {});
    (message.content.update as AcpUpdate & { raw_input?: Record<string, unknown> }).raw_input = {
      path: 'out/index.htm',
    };
    expect(extractToolFileTargets(message).map((t) => t.path)).toEqual(['out/index.htm']);
  });

  it('ignores read tools and non-document files', () => {
    expect(extractToolFileTargets(acp('t1', { kind: 'read', rawInput: { file_path: '/ws/a.md' } }))).toEqual([]);
    expect(extractToolFileTargets(acp('t2', { rawInput: { file_path: '/ws/a.ts' } }))).toEqual([]);
  });

  it('reports status so callers can skip unfinished calls', () => {
    const [target] = extractToolFileTargets(acp('t1', { status: 'in_progress', rawInput: { file_path: 'a.md' } }));
    expect(target.completed).toBe(false);
  });

  it('finds documents written by an officecli execute command', () => {
    const message = acp('t1', {
      kind: 'execute',
      rawInput: { command: 'officecli create "Q3 report.docx" --title X' },
    });
    expect(extractToolFileTargets(message).map((t) => t.path)).toEqual(['Q3 report.docx']);
  });

  it('handles argv-style commands', () => {
    const message = acp('t1', {
      kind: 'execute',
      rawInput: { command: ['bash', '-lc', 'officecli add deck.pptx /slide'] },
    });
    expect(extractToolFileTargets(message).map((t) => t.path)).toEqual(['deck.pptx']);
  });
});

describe('extractWrittenFilesFromCommand', () => {
  it('skips officecli read-only verbs', () => {
    expect(extractWrittenFilesFromCommand('officecli view report.docx')).toEqual([]);
    expect(extractWrittenFilesFromCommand('officecli get report.xlsx /Sheet1/A1')).toEqual([]);
  });

  it('applies a preceding cd to relative paths', () => {
    expect(extractWrittenFilesFromCommand('cd out && officecli create book.xlsx')).toEqual(['out/book.xlsx']);
    expect(extractWrittenFilesFromCommand('cd /tmp/x; officecli create /abs/a.docx')).toEqual(['/abs/a.docx']);
  });

  it('detects redirection, tee, cp/mv destinations and -o flags', () => {
    expect(extractWrittenFilesFromCommand('echo "# hi" > README.md')).toEqual(['README.md']);
    expect(extractWrittenFilesFromCommand('cat a.txt | tee out.html')).toEqual(['out.html']);
    expect(extractWrittenFilesFromCommand('cp draft.md final.md')).toEqual(['final.md']);
    expect(extractWrittenFilesFromCommand('pandoc in.md -o out.pdf')).toEqual(['out.pdf']);
    expect(extractWrittenFilesFromCommand('pandoc in.md --output=out.docx')).toEqual(['out.docx']);
  });

  it('does not report paths that are only read', () => {
    expect(extractWrittenFilesFromCommand('cat report.md')).toEqual([]);
    expect(extractWrittenFilesFromCommand('python build.py report.html')).toEqual([]);
    expect(extractWrittenFilesFromCommand('ls docs 2> errors.md')).toEqual(['errors.md']);
  });

  it('keeps Windows backslash paths intact', () => {
    expect(extractWrittenFilesFromCommand('officecli create C:\\Users\\me\\out.docx')).toEqual([
      'C:\\Users\\me\\out.docx',
    ]);
  });
});

describe('extractToolFileTargets — aionrs', () => {
  it('reads write tool_call inputs and bash commands', () => {
    const write: IMessageToolCall = {
      id: 'm1',
      conversation_id: 'c1',
      type: 'tool_call',
      content: { call_id: 'k1', name: 'Write', args: {}, input: { file_path: '/ws/page.html' }, status: 'completed' },
    };
    const bash: IMessageToolCall = {
      id: 'm2',
      conversation_id: 'c1',
      type: 'tool_call',
      content: { call_id: 'k2', name: 'Bash', args: { command: 'officecli create a.xlsx' }, status: 'completed' },
    };
    const read: IMessageToolCall = {
      id: 'm3',
      conversation_id: 'c1',
      type: 'tool_call',
      content: { call_id: 'k3', name: 'read_file', args: { path: '/ws/page.html' }, status: 'completed' },
    };
    expect(extractToolFileTargets(write).map((t) => t.path)).toEqual(['/ws/page.html']);
    expect(extractToolFileTargets(bash).map((t) => t.path)).toEqual(['a.xlsx']);
    expect(extractToolFileTargets(read)).toEqual([]);
  });

  it('reads tool_group edit confirmations and WriteFile results', () => {
    const group: IMessageToolGroup = {
      id: 'g1',
      conversation_id: 'c1',
      type: 'tool_group',
      content: [
        {
          call_id: 'a',
          name: 'WriteFile',
          description: '',
          render_output_as_markdown: false,
          status: 'Success',
          result_display: { file_diff: '+x', file_name: 'notes.md' },
        },
        {
          call_id: 'b',
          name: 'Shell',
          description: '',
          render_output_as_markdown: false,
          status: 'Executing',
          confirmationDetails: {
            type: 'exec',
            title: 't',
            rootCommand: 'officecli',
            command: 'officecli create r.docx',
          },
        },
      ],
    };
    expect(extractToolFileTargets(group)).toEqual([
      { path: 'notes.md', toolKey: 'a', completed: true },
      { path: 'r.docx', toolKey: 'b', completed: false },
    ]);
  });
});

describe('collectTurnFiles', () => {
  it('de-duplicates one file across calls and spellings, keeping first-seen order', () => {
    const files = collectTurnFiles([
      acp('t1', { locations: [{ path: './out/Report.html' }], rawInput: { file_path: 'out/Report.html' } }),
      acp('t2', { rawInput: { file_path: 'notes.md' } }),
      acp('t3', { rawInput: { file_path: 'out\\report.html' } }),
      acp('t4', { status: 'failed', rawInput: { file_path: 'broken.md' } }),
    ]);
    expect(files.map((f) => f.name)).toEqual(['Report.html', 'notes.md']);
  });
});
