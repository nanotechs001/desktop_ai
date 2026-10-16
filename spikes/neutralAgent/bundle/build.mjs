// Spike (verdict 3): bundles the artifact libraries into IIFE files under dist/ that expose window globals.
// React is bundled once; every other bundle reads React/ReactDOM from the window so all share one copy.
import fs from 'node:fs';
import { build } from 'esbuild';

const shared = {
  react: 'window.React',
  'react/jsx-runtime': 'window.ReactJSXRuntime',
  'react-dom': 'window.ReactDOM',
};
/** Resolves the shared modules to the globals the React bundle sets. */
const globalsPlugin = (filter) => ({
  name: 'use-globals',
  setup(b) {
    b.onResolve({ filter }, (a) => ({ path: a.path, namespace: 'global' }));
    b.onLoad({ filter: /.*/, namespace: 'global' }, (a) => ({ contents: `module.exports = ${shared[a.path]};` }));
  },
});
const useGlobals = globalsPlugin(/^(react|react\/jsx-runtime|react-dom)$/);
// react-dom/client imports react-dom itself, so its own bundle shares only React.
const useReactGlobal = globalsPlugin(/^(react|react\/jsx-runtime)$/);

const common = {
  bundle: true,
  format: 'iife',
  minify: true,
  legalComments: 'eof',
  target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
};
const entries = [
  ['react', "window.React = require('react'); window.ReactJSXRuntime = require('react/jsx-runtime');", []],
  [
    'react-dom',
    "const c = require('react-dom/client'); window.ReactDOM = { ...require('react-dom'), ...c };",
    [useReactGlobal],
  ],
  ['recharts', "window.Recharts = require('recharts');", [useGlobals]],
  ['lucide-react', "window.LucideReact = require('lucide-react');", [useGlobals]],
  [
    'react-markdown',
    "export { default } from 'react-markdown'; import M from 'react-markdown'; window.ReactMarkdown = M;",
    [useGlobals],
  ],
  ['sucrase', "window.Sucrase = { transform: require('sucrase').transform };", []],
];
fs.mkdirSync('dist', { recursive: true });
for (const [name, contents, plugins] of entries) {
  await build({ ...common, stdin: { contents, resolveDir: '.', loader: 'js' }, outfile: `dist/${name}.js`, plugins });
}
fs.copyFileSync('node_modules/@tailwindcss/browser/dist/index.global.js', 'dist/tailwind.js');
for (const f of fs.readdirSync('dist')) console.log(f.padEnd(20), fs.statSync(`dist/${f}`).size);
