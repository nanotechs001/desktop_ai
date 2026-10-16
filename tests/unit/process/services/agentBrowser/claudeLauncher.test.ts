import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BUILTIN_ARTIFACTS_MCP_NAME,
  BUILTIN_BROWSER_MCP_NAME,
  BUILTIN_NOTES_MCP_NAME,
} from '@/common/config/constants';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildHookScript,
  buildLauncherScript,
  ensureClaudeLauncher,
  isBrowserOpenCommand,
  type ClaudeLauncherDeps,
} from '@process/services/agentBrowser/claudeLauncher';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'aion-launcher-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const writeExecutable = (file: string, content: string): string => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  chmodSync(file, 0o755);
  return file;
};

/** A stand-in `claude` that prints its own path then one argument per line. */
const FAKE_CLAUDE = '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n';

describe('isBrowserOpenCommand', () => {
  it.each([
    'open https://x.com',
    '/usr/bin/open https://x.com',
    'open -a "Google Chrome" https://x.com',
    'FOO=1 open https://x.com',
    'cd a && open https://x.com',
    'ls; open https://x.com',
    'echo hi | open -f',
    'echo $(open https://x.com)',
    'xdg-open https://x.com',
    'gio open https://x.com',
    'sensible-browser https://x.com',
    'python3 -m webbrowser https://x.com',
    'python -m webbrowser https://x.com',
    'osascript -e \'open location "https://x.com"\'',
    'osascript -e \'tell application "Google Chrome" to activate\'',
    'cmd /c start http://x.com',
    'nohup open https://x.com',
    'FOO=1 nohup exec open https://x.com',
    'sudo open https://x.com',
    'sudo -n open https://x.com',
    'env FOO=1 open https://x.com',
    '/usr/bin/env open https://x.com',
    'time open https://x.com',
    'nice -n 10 open https://x.com',
    'echo https://x.com | xargs open',
    'if true; then open https://x.com; fi',
    'for u in a b; do open $u; done',
    '{ open https://x.com; }',
    '! open https://x.com',
    'bash -c "open https://x.com"',
    "sh -c 'open https://x.com'",
    'zsh -lc "cd a && open https://x.com"',
    'sudo bash -c "xdg-open https://x.com"',
    'eval "open https://x.com"',
    'eval open https://x.com',
    'python3 -c "import webbrowser; webbrowser.open(\'https://x.com\')"',
    'cat <<EOF > f\nhi\nEOF\nopen https://x.com',
    'cat <<EOF\nEOF\nopen x\necho hi\nEOF',
    'cat <<EOF\nEOF\nopen x\ncat <<EOF\nz\nEOF',
    "echo '<<EOF'\nopen x\nEOF",
    'git commit -m "see <<EOF"\nopen x\nEOF',
    'echo $((1<<2))\nopen x\n2',
    'cat <<A <<B\n1\nA\n2\nB\nopen x',
    'cat <<EOF | open -f -\nbody\nEOF',
    '"open" https://x.com',
    "'open' https://x.com",
    '\\open https://x.com',
    '"/usr/bin/open" https://x.com',
    'sudo "open" https://x.com',
  ])('%s is a browser-open command', (command) => {
    expect(isBrowserOpenCommand(command)).toBe(true);
  });

  it.each([
    'openssl rand 4',
    'git status',
    'git open-pr',
    'npm run open-api',
    'cat open.txt',
    'echo open',
    'git commit -m "docs; open the file"',
    'osascript -e \'tell application "Finder" to activate\'',
    'python3 script.py',
    'python3 -c "print(1)"',
    './open',
    './scripts/open https://x.com',
    'scripts/open https://x.com',
    '/home/me/project/bin/open https://x.com',
    'bash -c "echo hi"',
    'eval "echo open"',
    'cat <<EOF\nopen https://x.com\nEOF',
    "cat > notes.md <<'EOF'\nopen https://x.com\nEOF\nls",
    'cat <<-EOF\n\topen https://x.com\n\tEOF',
    '',
  ])('%s is not', (command) => {
    expect(isBrowserOpenCommand(command)).toBe(false);
  });
});

describe('buildHookScript', () => {
  const runHook = (stdin: string) => {
    const file = path.join(tmp, 'aion-block-browser-open.cjs');
    writeFileSync(file, buildHookScript());
    return spawnSync(process.execPath, [file], { input: stdin, encoding: 'utf8' });
  };

  it('blocks a Bash open with decision "block" (and the newer deny form) and allows ls', () => {
    const blocked = runHook(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cd x && open https://x.com' } })
    );
    expect(blocked.status).toBe(0);
    const out = JSON.parse(blocked.stdout);
    expect(out.decision).toBe('block');
    expect(out.reason).toBe(
      'Use the AionUi browser pane tools (aionui-browser) instead of opening an external browser.'
    );
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: out.reason,
    });

    const allowed = runHook(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }));
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toBe('');
  });

  it('ignores other tools and malformed input without failing', () => {
    expect(runHook(JSON.stringify({ tool_name: 'Read', tool_input: { command: 'open x' } })).stdout).toBe('');
    const garbage = runHook('not json');
    expect(garbage.status).toBe(0);
    expect(garbage.stdout).toBe('');
  });
});

describe('buildLauncherScript', () => {
  const runLauncher = (script: string, args: string[], env: Record<string, string>) => {
    const file = writeExecutable(path.join(tmp, 'launcher', 'claude-aion'), script);
    return { file, ...spawnSync('/bin/sh', [file, ...args], { encoding: 'utf8', env }) };
  };

  it('launcher settings allow mcp__aionui-browser, mcp__aionui-artifacts and mcp__aionui-notes; appends --no-chrome, the three disallowedTools and --settings with the hook path', () => {
    const fakeBin = path.join(tmp, 'bin');
    writeExecutable(path.join(fakeBin, 'claude'), FAKE_CLAUDE);
    const hookPath = path.join(tmp, 'dir with space', "it's$hook.cjs");
    const result = runLauncher(buildLauncherScript(hookPath, []), ['--print', 'a b'], {
      PATH: fakeBin,
      HOME: tmp,
    });
    expect(result.status).toBe(0);
    const [, ...args] = result.stdout.trimEnd().split('\n');
    expect(args.slice(0, 2)).toEqual(['--print', 'a b']);
    expect(args.slice(2, 8)).toEqual([
      '--no-chrome',
      '--disallowedTools',
      'Bash(open:*)',
      'Bash(xdg-open:*)',
      'Bash(osascript:*)',
      '--settings',
    ]);
    expect(JSON.parse(args[8])).toEqual({
      permissions: {
        allow: [
          `mcp__${BUILTIN_BROWSER_MCP_NAME}`,
          `mcp__${BUILTIN_ARTIFACTS_MCP_NAME}`,
          `mcp__${BUILTIN_NOTES_MCP_NAME}`,
        ],
      },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: `node "${hookPath.replace('$', '\\$')}"` }] },
        ],
      },
    });
    expect(args).toHaveLength(9);
  });

  it('skips itself when it appears on PATH as claude', () => {
    const selfDir = path.join(tmp, 'selfdir');
    const realDir = path.join(tmp, 'realdir');
    writeExecutable(path.join(realDir, 'claude'), FAKE_CLAUDE);
    const { file } = runLauncher(buildLauncherScript('/h.cjs', []), ['--version'], { PATH: '', HOME: tmp });
    mkdirSync(selfDir);
    symlinkSync(file, path.join(selfDir, 'claude'));
    const result = spawnSync('/bin/sh', [path.join(selfDir, 'claude'), '--version'], {
      encoding: 'utf8',
      env: { PATH: `${selfDir}:${realDir}`, HOME: tmp },
    });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe(path.join(realDir, 'claude'));
  });

  it('falls back to the newest nvm install when PATH has no claude', () => {
    const nvm = path.join(tmp, '.nvm', 'versions', 'node');
    writeExecutable(path.join(nvm, 'v9.1.0', 'bin', 'claude'), FAKE_CLAUDE);
    writeExecutable(path.join(nvm, 'v24.22.0', 'bin', 'claude'), FAKE_CLAUDE);
    const result = runLauncher(buildLauncherScript('/h.cjs', []), [], { PATH: '', HOME: tmp });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe(path.join(nvm, 'v24.22.0', 'bin', 'claude'));
  });

  it.each([
    ['.local', 'bin', 'claude'],
    ['.claude', 'local', 'claude'],
  ])('falls back to the native installer location ~/%s/%s/%s', (...parts) => {
    const claude = writeExecutable(path.join(tmp, ...parts), FAKE_CLAUDE);
    const result = runLauncher(buildLauncherScript('/h.cjs', []), [], { PATH: '', HOME: tmp });
    expect(result.status).toBe(0);
    expect(result.stdout.split('\n')[0]).toBe(claude);
  });

  it('exits non-zero with a how-to-fix message when no other claude is on PATH', () => {
    const selfDir = path.join(tmp, 'launcher');
    const result = runLauncher(buildLauncherScript('/h.cjs', []), [], { PATH: selfDir, HOME: tmp });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/could not find Claude Code/);
    expect(result.stderr).toMatch(/Install Claude Code/);
    expect(result.stderr).toMatch(/set your own Claude command/);
    expect(result.stderr).not.toMatch(/clear|skipped/);
  });
});

describe('ensureClaudeLauncher', () => {
  const launcherPath = () => path.join(tmp, '.aionui', 'bin', 'claude-aion');
  const makeDeps = (overrides: Partial<ClaudeLauncherDeps> = {}) => {
    const files = new Map<string, string>();
    const deps: ClaudeLauncherDeps = {
      homeDir: tmp,
      listAgents: async () => [
        { id: 'gemini', backend: 'gemini' },
        { id: 'claude', backend: 'claude' },
      ],
      getOverrides: async () => ({}),
      setOverride: vi.fn(async () => undefined),
      readFile: async (p) => files.get(p) ?? null,
      writeFile: vi.fn(async (p: string, s: string) => {
        files.set(p, s);
      }),
      warn: vi.fn(),
      ...overrides,
    };
    return { deps, files };
  };

  it('installs scripts with mode 0755 and sets the override when none exists', async () => {
    const { deps, files } = makeDeps();
    await expect(ensureClaudeLauncher(deps)).resolves.toBe('installed');
    const hookPath = path.join(tmp, '.aionui', 'bin', 'aion-block-browser-open.cjs');
    expect(deps.writeFile).toHaveBeenCalledWith(hookPath, buildHookScript(), 0o755);
    expect(deps.writeFile).toHaveBeenCalledWith(launcherPath(), buildLauncherScript(hookPath), 0o755);
    expect(files.size).toBe(2);
    expect(deps.setOverride).toHaveBeenCalledWith('claude', launcherPath());
  });

  it('leaves a user override alone and warns', async () => {
    const { deps } = makeDeps({ getOverrides: async () => ({ command_override: '/my/claude' }) });
    await expect(ensureClaudeLauncher(deps)).resolves.toBe('user-override');
    expect(deps.setOverride).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it('returns "already" when our launcher is the override and rewrites scripts only if they differ', async () => {
    const { deps, files } = makeDeps({ getOverrides: async () => ({ command_override: launcherPath() }) });
    await expect(ensureClaudeLauncher(deps)).resolves.toBe('already');
    expect(deps.writeFile).toHaveBeenCalledTimes(2);
    expect(deps.setOverride).not.toHaveBeenCalled();
    vi.mocked(deps.writeFile).mockClear();
    expect(files.size).toBe(2);
    await expect(ensureClaudeLauncher(deps)).resolves.toBe('already');
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('prefers the builtin Claude agent over a custom one with backend claude', async () => {
    const { deps } = makeDeps({
      listAgents: async () => [
        { id: 'custom-claude', backend: 'claude', source: 'custom' },
        { id: 'builtin-claude', backend: 'claude', source: 'builtin' },
      ],
    });
    await expect(ensureClaudeLauncher(deps)).resolves.toBe('installed');
    expect(deps.setOverride).toHaveBeenCalledWith('builtin-claude', launcherPath());
  });

  it('reports no-claude-agent and failed', async () => {
    const none = makeDeps({ listAgents: async () => [{ id: 'g', backend: 'gemini' }] });
    await expect(ensureClaudeLauncher(none.deps)).resolves.toBe('no-claude-agent');
    const broken = makeDeps({
      listAgents: async () => {
        throw new Error('backend down');
      },
    });
    await expect(ensureClaudeLauncher(broken.deps)).resolves.toBe('failed');
  });
});

describe('hook script from a bundled build', () => {
  // The hook inlines isBrowserOpenCommand.toString(), so a bundler that renames or rewrites the function
  // must not change how it classifies. Bundle the real module with esbuild (the minifier behind Vite) and
  // run the hook generated from that output.
  it.each([
    ['minified', { minify: true }],
    ['minified with keepNames', { minify: true, keepNames: true }],
  ])('classifies correctly when the module is bundled %s', async (_label, options) => {
    const { build } = await import('esbuild');
    const bundled = await build({
      entryPoints: [
        path.resolve(__dirname, '../../../../../packages/desktop/src/process/services/agentBrowser/claudeLauncher.ts'),
      ],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'es2022',
      ...options,
    });
    const moduleFile = path.join(tmp, 'bundle.cjs');
    writeFileSync(moduleFile, bundled.outputFiles[0].text);
    const hookFile = path.join(tmp, 'hook.cjs');
    const generator = spawnSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(moduleFile)}); require('fs').writeFileSync(${JSON.stringify(hookFile)}, require(${JSON.stringify(moduleFile)}).buildHookScript())`,
      ],
      { encoding: 'utf8' }
    );
    expect(generator.status, generator.stderr).toBe(0);

    const run = (command: string) =>
      spawnSync(process.execPath, [hookFile], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
        encoding: 'utf8',
      });
    expect(JSON.parse(run('cd x && bash -c "open https://x.com"').stdout).decision).toBe('block');
    expect(run('git commit -m "docs; open the file"').stdout).toBe('');
    expect(run('./scripts/open x').stdout).toBe('');
  });
});
