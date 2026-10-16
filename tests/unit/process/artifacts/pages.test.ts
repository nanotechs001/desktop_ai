/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ArtifactKind, ArtifactVersion } from '@/common/types/agent/artifacts';
import { renderArtifactPage } from '@process/artifacts/pages';

const version = (kind: ArtifactKind, content: string, title = 'T'): ArtifactVersion => ({
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  conversationId: 'conv1',
  title,
  kind,
  createdAt: 1,
  updatedAt: 1,
  latest: 1,
  version: 1,
  content,
});

const JSON_BLOCK_RE = /<script type="application\/json" id="artifact-source">([\s\S]*?)<\/script>/g;
const scriptSrcs = (html: string): string[] => [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1]);
const outsideJson = (html: string): string => html.replace(JSON_BLOCK_RE, '');
/** The embedded source as the page's own `JSON.parse(block.textContent)` reads it. */
const embedded = (html: string): unknown[] => [...html.matchAll(JSON_BLOCK_RE)].map((m) => JSON.parse(m[1]));

describe('renderArtifactPage', () => {
  it('serves html as written', () => {
    expect(renderArtifactPage(version('html', '<h1>x</h1>'))).toBe('<h1>x</h1>');
  });

  it('wraps svg in an <img> data url and escapes the title', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const html = renderArtifactPage(version('svg', svg, '"><script>'));
    expect(html).toContain(`<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"`);
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('"><script>');
  });

  it('react page embeds source as JSON and references only /lib/ scripts', () => {
    const source =
      "import { useState } from 'react';\nexport default function App() { return <p>{'zebra-says-hello'}</p>; }";
    const html = renderArtifactPage(version('react', source));
    expect(embedded(html)).toEqual([source]);
    // The source is never part of the markup or of a script.
    expect(outsideJson(html)).not.toContain('zebra-says-hello');
    expect(scriptSrcs(html)).toEqual([
      '/lib/react.js',
      '/lib/react-dom.js',
      '/lib/sucrase.js',
      '/lib/recharts.js',
      '/lib/lucide.js',
      '/lib/tailwind.js',
    ]);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("transforms: ['jsx', 'typescript', 'imports']");
  });

  it.each(['react', 'markdown', 'mermaid'] as const)(
    'content containing </script> cannot break out of the JSON block (%s)',
    (kind) => {
      const evil = '</script><script>alert(1)</script><!--<SCRIPT> </Script >';
      const html = renderArtifactPage(version(kind, evil, '</title><script>alert(2)</script>'));
      expect(embedded(html)).toEqual([evil]);
      const [block] = [...html.matchAll(JSON_BLOCK_RE)].map((m) => m[1]);
      expect(block).not.toMatch(/</);
      expect(html).not.toContain('alert(1)</script>');
      expect(html).not.toContain('<script>alert(2)');
      // Every script that opens is one of ours.
      expect(html.match(/<script\b/gi)?.length).toBe(html.match(/<\/script>/gi)?.length);
    }
  );

  it('markdown and mermaid pages reference only /lib/ scripts', () => {
    const markdown = renderArtifactPage(version('markdown', '# Hi\n\n```mermaid\ngraph TD; A-->B\n```'));
    expect(scriptSrcs(markdown)).toEqual([
      '/lib/react.js',
      '/lib/react-dom.js',
      '/lib/react-markdown.js',
      '/lib/mermaid.js',
    ]);
    const mermaid = renderArtifactPage(version('mermaid', 'graph TD; A-->B'));
    expect(scriptSrcs(mermaid)).toEqual(['/lib/mermaid.js']);
    for (const html of [markdown, mermaid]) {
      expect(html).not.toMatch(/https?:\/\//);
      expect(outsideJson(html)).not.toContain('A-->B');
      expect(embedded(html)).toHaveLength(1);
    }
  });
});
