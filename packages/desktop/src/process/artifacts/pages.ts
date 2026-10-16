/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ArtifactVersion } from '@/common/types/agent/artifacts';

/*
 * Artifact pages. Every page is served under the sandboxed artifact CSP and loads its libraries only from the
 * artifact server's /lib/ (built by scripts/build-mcp-servers.js). The artifact's content is never written into
 * the markup or a script: it travels as a JSON string in a `<script type="application/json">` block.
 */

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** JSON with every `<` escaped, so nothing in it can close the script block (`</script>`, `<!--`). */
const sourceBlock = (content: string): string =>
  `<script type="application/json" id="artifact-source">${JSON.stringify(content).replace(/</g, '\\u003c')}</script>`;

const page = (title: string, head: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)}</title>${head}</head><body>${body}</body></html>`;

const libs = (files: string[]): string => files.map((f) => `<script src="/lib/${f}"></script>`).join('');

/** Shared by the script pages: `source`, `root`, and `showError`, which replaces the page with a red message. */
const PRELUDE = `
const root = document.getElementById('root');
const errorBox = (e) => {
  const pre = document.createElement('pre');
  pre.style.cssText = 'color:#b91c1c;white-space:pre-wrap;margin:16px;font:13px/1.5 ui-monospace,monospace';
  pre.textContent = String((e && e.message) || e);
  return pre;
};
const showError = (e) => root.replaceChildren(errorBox(e));
window.addEventListener('error', (e) => showError(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showError(e.reason));
const source = JSON.parse(document.getElementById('artifact-source').textContent);
`;

const REACT_BOOT = `
const MODULES = { react: React, recharts: Recharts, 'lucide-react': LucideReact };
const load = (name) => {
  if (Object.hasOwn(MODULES, name)) return MODULES[name];
  throw new Error('Cannot import "' + name + '". Artifacts can import react, recharts and lucide-react.');
};
try {
  const { code } = Sucrase.transform(source, { transforms: ['jsx', 'typescript', 'imports'], production: true });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'React', code)(load, module, module.exports, React);
  const App = module.exports.default;
  if (!App) throw new Error('The artifact needs a default export: the React component to show.');
  ReactDOM.createRoot(root, { onUncaughtError: showError }).render(React.createElement(App));
} catch (e) {
  showError(e);
}
`;

const MERMAID_INIT = "mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });";

const MARKDOWN_BOOT = `
${MERMAID_INIT}
let diagrams = 0;
function Mermaid({ code }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    let live = true;
    mermaid.render('mermaid-' + diagrams++, code).then(
      ({ svg }) => { if (live) ref.current.innerHTML = svg; },
      (e) => { if (live) ref.current.replaceChildren(errorBox(e)); }
    );
    return () => { live = false; };
  }, [code]);
  return React.createElement('div', { ref, className: 'mermaid' });
}
/** A \`\`\`mermaid fence becomes a diagram; every other block stays as written. */
const pre = ({ node, children, ...rest }) => {
  const code = node && node.children && node.children[0];
  const classes = (code && code.tagName === 'code' && code.properties.className) || [];
  if (!classes.includes('language-mermaid')) return React.createElement('pre', rest, children);
  const text = code.children.map((c) => c.value || '').join('').replace(/\\n$/, '');
  return React.createElement(Mermaid, { code: text });
};
try {
  ReactDOM.createRoot(root, { onUncaughtError: showError }).render(
    React.createElement(ReactMarkdown, { components: { pre } }, source)
  );
} catch (e) {
  showError(e);
}
`;

const MARKDOWN_STYLE =
  '<style>body{margin:0;font:16px/1.6 system-ui,sans-serif}#root{max-width:860px;margin:0 auto;padding:24px}' +
  'pre{overflow:auto;padding:12px;background:#f4f4f5;border-radius:6px}code{font-family:ui-monospace,monospace}' +
  'img{max-width:100%}.mermaid{margin:16px 0}</style>';

const MERMAID_BOOT = `
${MERMAID_INIT}
mermaid.render('mermaid-0', source).then(({ svg }) => { root.innerHTML = svg; }, showError);
`;

const scriptPage = (v: ArtifactVersion, files: string[], boot: string, style = ''): string =>
  page(
    v.title,
    style,
    `<div id="root"></div>${sourceBlock(v.content)}${libs(files)}<script>${PRELUDE}${boot}</script>`
  );

/**
 * Renders an artifact version as a page.
 * - html: as written.
 * - svg: inside an `<img>` wrapper (never inline).
 * - react: compiled in the page by Sucrase; may import react, recharts and lucide-react; Tailwind is on.
 * - markdown: react-markdown, with ```mermaid fences drawn as diagrams.
 * - mermaid: one diagram.
 * Compile and runtime errors show up in the page as a red message.
 */
export function renderArtifactPage(v: ArtifactVersion): string {
  switch (v.kind) {
    case 'html':
      return v.content;
    case 'svg': {
      const src = `data:image/svg+xml;base64,${Buffer.from(v.content, 'utf8').toString('base64')}`;
      const style =
        '<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center}' +
        'img{max-width:100%;max-height:100%}</style>';
      return page(v.title, style, `<img src="${src}" alt="${escapeHtml(v.title)}">`);
    }
    case 'react':
      return scriptPage(
        v,
        ['react.js', 'react-dom.js', 'sucrase.js', 'recharts.js', 'lucide.js', 'tailwind.js'],
        REACT_BOOT
      );
    case 'markdown':
      return scriptPage(
        v,
        ['react.js', 'react-dom.js', 'react-markdown.js', 'mermaid.js'],
        MARKDOWN_BOOT,
        MARKDOWN_STYLE
      );
    case 'mermaid':
      return scriptPage(v, ['mermaid.js'], MERMAID_BOOT);
  }
}
