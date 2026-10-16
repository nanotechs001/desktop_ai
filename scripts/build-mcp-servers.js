#!/usr/bin/env node
/**
 * Build builtin MCP server scripts as fully self-contained CJS bundles.
 *
 * electron-vite's externalizeDepsPlugin leaves all npm packages as require()
 * calls, which works for Electron's main process (ASAR virtual FS patches
 * require()) but fails when an external `node` process runs the script from
 * app.asar.unpacked — there is no ASAR support there.
 *
 * It also bundles the offline libraries for artifact pages into out/main/artifact-libs/ (see
 * buildArtifactLibs below), with a manifest.json (file -> sha256) and LICENSES.txt.
 *
 * This script uses esbuild's programmatic API (instead of CLI flags) to avoid
 * shell-quoting issues with special characters in --define values.
 */

const crypto = require('crypto');
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** `import text from './file?raw'` (the Vite convention, also used by vitest) as the file's text. */
const RAW_IMPORT_PLUGIN = {
  name: 'raw-import',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)),
      namespace: 'raw-import',
    }));
    build.onLoad({ filter: /.*/, namespace: 'raw-import' }, (args) => ({
      contents: fs.readFileSync(args.path, 'utf8'),
      loader: 'text',
    }));
  },
};

const SHARED_OPTIONS = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  loader: { '.wasm': 'empty' },
  plugins: [RAW_IMPORT_PLUGIN],
};

/**
 * Offline libraries for artifact pages (served by the artifact server at /lib/<file>). Each is an IIFE that sets
 * a window global; every bundle but React's own reads React from window, so all pages share one copy.
 */
const ARTIFACT_LIBS_DIR = path.join(ROOT, 'out/main/artifact-libs');
const SHARED_GLOBALS = {
  react: 'window.React',
  'react/jsx-runtime': 'window.ReactJSXRuntime',
  'react-dom': 'window.ReactDOM',
};

/** Resolves the listed shared modules to the globals the React bundles set. */
const useGlobals = (names) => ({
  name: 'use-globals',
  setup(build) {
    const filter = new RegExp(`^(${names.map((n) => n.replace('/', '\\/')).join('|')})$`);
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'global' }));
    build.onLoad({ filter: /.*/, namespace: 'global' }, (args) => ({
      contents: `module.exports = ${SHARED_GLOBALS[args.path]};`,
    }));
  },
});
const ALL_SHARED = Object.keys(SHARED_GLOBALS);

const ARTIFACT_LIBS = [
  { file: 'react.js', code: "window.React = require('react'); window.ReactJSXRuntime = require('react/jsx-runtime');" },
  // react-dom/client imports react-dom itself, so this bundle shares only React.
  {
    file: 'react-dom.js',
    code: "window.ReactDOM = { ...require('react-dom'), ...require('react-dom/client') };",
    shared: ['react', 'react/jsx-runtime'],
  },
  { file: 'recharts.js', code: "window.Recharts = require('recharts');", shared: ALL_SHARED },
  { file: 'lucide.js', code: "window.LucideReact = require('lucide-react');", shared: ALL_SHARED },
  {
    file: 'react-markdown.js',
    code: "window.ReactMarkdown = require('react-markdown').default; window.remarkGfm = require('remark-gfm').default;",
    shared: ALL_SHARED,
  },
  { file: 'sucrase.js', code: "window.Sucrase = { transform: require('sucrase').transform };" },
  { file: 'mermaid.js', code: "window.mermaid = require('mermaid').default;" },
];
/** Already shipped as an IIFE by the package: copied as is. */
const COPIED_LIBS = [{ file: 'tailwind.js', pkg: '@tailwindcss/browser', from: 'dist/index.global.js' }];

/** The package folder (inside node_modules) an esbuild input path belongs to, or null for our own code. */
const packageDirOf = (input) => {
  const at = input.lastIndexOf('node_modules/');
  if (at < 0) return null;
  const parts = input.slice(at + 'node_modules/'.length).split('/');
  return path.join(ROOT, input.slice(0, at), 'node_modules', ...parts.slice(0, parts[0].startsWith('@') ? 2 : 1));
};

/** One LICENSES.txt section per package: name, version, declared license and the package's license file. */
const licenseSection = (pkgDir) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const licenseFile = fs.readdirSync(pkgDir).find((f) => /^(licen[cs]e|copying)(\.|-|$)/i.test(f));
  const text = licenseFile
    ? fs.readFileSync(path.join(pkgDir, licenseFile), 'utf8').trim()
    : `(the package ships no license file; package.json declares ${pkg.license ?? 'no license'})`;
  return { name: pkg.name, body: `== ${pkg.name}@${pkg.version} (${pkg.license ?? 'unknown'}) ==\n\n${text}\n` };
};

async function buildArtifactLibs() {
  fs.rmSync(ARTIFACT_LIBS_DIR, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACT_LIBS_DIR, { recursive: true });
  const results = await Promise.all(
    ARTIFACT_LIBS.map(({ file, code, shared }) =>
      esbuild.build({
        absWorkingDir: ROOT,
        stdin: { contents: code, resolveDir: ROOT, loader: 'js' },
        outfile: path.join(ARTIFACT_LIBS_DIR, file),
        bundle: true,
        format: 'iife',
        platform: 'browser',
        minify: true,
        legalComments: 'eof',
        target: 'es2020',
        define: { 'process.env.NODE_ENV': '"production"' },
        metafile: true,
        logLevel: 'warning',
        plugins: shared ? [useGlobals(shared)] : [],
      })
    )
  );
  const pkgDirs = new Set(COPIED_LIBS.map(({ pkg }) => path.join(ROOT, 'node_modules', pkg)));
  for (const { metafile } of results) {
    for (const input of Object.keys(metafile.inputs)) {
      const dir = packageDirOf(input);
      if (dir) pkgDirs.add(dir);
    }
  }
  for (const { file, pkg, from } of COPIED_LIBS) {
    fs.copyFileSync(path.join(ROOT, 'node_modules', pkg, from), path.join(ARTIFACT_LIBS_DIR, file));
  }

  const files = [...ARTIFACT_LIBS, ...COPIED_LIBS].map(({ file }) => file).sort();
  const manifest = Object.fromEntries(
    files.map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(ARTIFACT_LIBS_DIR, file)))
        .digest('hex'),
    ])
  );
  fs.writeFileSync(path.join(ARTIFACT_LIBS_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const sections = [...pkgDirs].map(licenseSection).sort((a, b) => a.name.localeCompare(b.name));
  const unique = sections.filter((s, i) => i === 0 || s.body !== sections[i - 1].body);
  fs.writeFileSync(
    path.join(ARTIFACT_LIBS_DIR, 'LICENSES.txt'),
    `Third-party software bundled in ${files.join(', ')}:\n\n${unique.map((s) => s.body).join('\n')}`
  );
}

async function main() {
  await Promise.all([
    buildArtifactLibs(),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-image-gen.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/aionBrowser/server.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-browser.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/aionArtifacts/server.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-artifacts.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/aionNotes/server.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-notes.js'),
    }),
  ]);
}

main().catch((err) => {
  console.error('MCP server build failed:', err);
  process.exit(1);
});
