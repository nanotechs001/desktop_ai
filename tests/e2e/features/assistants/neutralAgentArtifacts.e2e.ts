/**
 * The neutral Agent and local Artifacts, end to end.
 *
 * The claude engine is pointed at a stub that speaks Claude Code's stream-json protocol (init, then one scripted turn
 * per user message), so chats get real replies and real tool calls through AionCore without a Claude account. The
 * built-in MCP servers (out/main/builtin-mcp-*.js) are driven over stdio the way an agent drives them, with the env
 * main exported for AionCore plus the chat id an agent's MCP child receives.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ElectronApplication, Page } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../../../integration/agentBrowser/helpers/fixtureServer';
import { test, expect } from '../../fixtures';
import {
  goToGuid,
  httpGet,
  httpInvoke,
  invokeBridge,
  openHistoryPanel,
  sendMessageFromGuid,
  setDefaultEngine,
  waitForAiReply,
} from '../../helpers';

const OUT_MAIN = path.resolve(__dirname, '../../../../out/main');
const DEFAULT_AGENT_ID = 'aion-default-agent';
/** Where the artifact store and notebooks of an e2e (second dev instance) app live: outside its temp userData. */
const E2E_DATA_HOME = path.join(os.homedir(), '.aionui-dev-2');
/** Vendor and product names that must not show in a chat's chrome. Case-sensitive: lowercase ids live in paths. */
const VENDOR_TEXT =
  /\b(Claude|Anthropic|Codex|OpenAI|ChatGPT|Gemini|Google|Qwen|iFlow|Goose|Copilot|OpenCode|Kimi|Droid)\b/;
const REMOVED_FEATURES = /\b(Teams?|Pet|Butler|Feedback|Bug report)\b/;
const STUB_REPLY = 'Done, here you go.';
const NO_CLAUDE_REASON = 'Needs the claude engine detected: the stub replaces its command, not its detection';

type ManagedAgent = { id: string; backend?: string; agent_source?: string };
type AssistantRow = { id: string; agent_id?: string; source?: string; name?: string };
/** One scripted agent turn: an optional MCP tool call (its result text as the MCP returned it), then a text reply. */
type StubTurn = { tool?: { name: string; input: Record<string, unknown>; result: string } };
type StubRun = { argv: string[]; env: Record<string, string | undefined> };

/** A claude command that answers every turn from `turn.json` (if present) and records how it was started. */
function writeClaudeStub(dir: string): string {
  const stub = path.join(dir, 'claude');
  fs.writeFileSync(
    stub,
    `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const DIR = ${JSON.stringify(dir)};
const pick = (k) => process.env[k];
fs.appendFileSync(path.join(DIR, 'runs.jsonl'), JSON.stringify({ argv: process.argv.slice(2), env: {
  AIONUI_CONVERSATION_ID: pick('AIONUI_CONVERSATION_ID'), AION_ARTIFACTS_URL: pick('AION_ARTIFACTS_URL') } }) + '\\n');
if (process.argv.includes('--version')) { console.log('2.1.0 (Claude Code)'); process.exit(0); }
const sid = 'e2e-stub-session';
const out = (o) => process.stdout.write(JSON.stringify({ session_id: sid, ...o }) + '\\n');
const assistant = (n, content) => out({ type: 'assistant', parent_tool_use_id: null, uuid: 'a' + n,
  message: { id: 'msg_' + n, type: 'message', role: 'assistant', model: 'stub', content, stop_reason: null,
    usage: { input_tokens: 1, output_tokens: 1 } } });
let turns = 0;
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }
  if (msg.type !== 'user') return;
  turns += 1;
  if (turns === 1) out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [],
    model: 'stub', permissionMode: 'default', apiKeySource: 'none', uuid: 'init' });
  const file = path.join(DIR, 'turn.json');
  const turn = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.rmSync(file, { force: true });
  if (turn.tool) {
    const id = 'toolu_e2e_' + turns;
    assistant(turns + '_tool', [{ type: 'tool_use', id, name: turn.tool.name, input: turn.tool.input }]);
    out({ type: 'user', parent_tool_use_id: null, uuid: 'r' + turns, message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: turn.tool.result }] }] } });
  }
  assistant(turns, [{ type: 'text', text: ${JSON.stringify(STUB_REPLY)} }]);
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
    result: ${JSON.stringify(STUB_REPLY)}, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, uuid: 'end' + turns });
});
`,
    { mode: 0o755 }
  );
  return stub;
}

/** The env an agent's MCP child gets: main's exports plus the chat it serves. */
async function agentEnv(electronApp: ElectronApplication, conversationId?: string): Promise<Record<string, string>> {
  const exported = await electronApp.evaluate(() => ({
    AION_ARTIFACTS_URL: process.env.AION_ARTIFACTS_URL ?? '',
    AION_ARTIFACTS_TOKEN: process.env.AION_ARTIFACTS_TOKEN ?? '',
    AION_BROWSER_RELAY_URL: process.env.AION_BROWSER_RELAY_URL ?? '',
    AION_BROWSER_RELAY_TOKEN: process.env.AION_BROWSER_RELAY_TOKEN ?? '',
  }));
  expect(exported.AION_ARTIFACTS_URL, 'main exported no artifact server').toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  return {
    ...(process.env as Record<string, string>),
    ...exported,
    ...(conversationId ? { AIONUI_CONVERSATION_ID: conversationId } : {}),
  };
}

/** Spawns a built-in MCP server (`builtin-mcp-<name>.js`) over stdio, as an agent would. */
async function connectMcp(electronApp: ElectronApplication, name: string, conversationId: string): Promise<Client> {
  const script = path.join(OUT_MAIN, `builtin-mcp-${name}.js`);
  if (!fs.existsSync(script)) throw new Error(`${script} is missing: run \`node scripts/build-mcp-servers.js\``);
  const client = new Client({ name: `e2e-${name}`, version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [script],
      env: await agentEnv(electronApp, conversationId),
      stderr: 'inherit',
    })
  );
  return client;
}

/** One tool call; the text of its first content item (throws on a tool error). */
async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const reply = await client.callTool({ name, arguments: args });
  const text = (reply.content as { text?: string }[])[0]?.text ?? '';
  if (reply.isError === true) throw new Error(`${name} failed: ${text}`);
  return text;
}

/** Creates a chat for `assistantId` (never messaged) and opens it, which mounts the browser pane. */
async function openNewChat(page: Page, assistantId: string, name: string): Promise<string> {
  const { id } = await httpInvoke<{ id: string }>(page, 'POST', '/api/conversations', {
    name,
    assistant: { id: assistantId },
    extra: { workspace: os.tmpdir(), custom_workspace: true, session_mode: 'default' },
  });
  await openChat(page, id);
  return id;
}

async function openChat(page: Page, conversationId: string): Promise<void> {
  await page.goto(`${page.url().split('#')[0]}#/conversation/${conversationId}`);
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 });
}

/** The Agents page (its own top-level route; the old settings tab redirects there). */
async function openAgentsPage(page: Page): Promise<void> {
  await page.goto(`${page.url().split('#')[0]}#/assistants`);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/assistants/);
}

/** Opens an Agent in the Agent editor from the Agents page's enabled list. */
async function openAgentEditor(page: Page, agentId: string): Promise<void> {
  await openAgentsPage(page);
  await page.locator(`[data-testid="enabled-assistant-row-${agentId}"]`).click();
  await expect(
    page.locator('[data-testid="assistant-editor-page"], [data-testid="assistant-edit-drawer"]')
  ).toBeVisible();
}

/** Every visible text and labelling attribute under `root`, outside the model chip (model names are allowed). */
const chromeText = (page: Page, root: string): Promise<string[]> =>
  page.evaluate((selector) => {
    const scope = document.querySelector(selector);
    if (!scope) return [`<no ${selector}>`];
    const allowed = (el: Element) =>
      el.closest('.sendbox-model-btn, [class*="model-selector"], [class*="ModelSelector"]');
    const texts: string[] = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent && !allowed(parent) && parent.checkVisibility() && node.textContent?.trim()) {
        texts.push(node.textContent.trim());
      }
    }
    for (const el of Array.from(scope.querySelectorAll('[alt], [title], [aria-label], [placeholder], img[src]'))) {
      if (allowed(el)) continue;
      for (const attr of ['alt', 'title', 'aria-label', 'placeholder', 'src']) {
        const value = el.getAttribute(attr);
        if (value) texts.push(`${attr}=${value}`);
      }
    }
    return texts;
  }, root);

/** A vendor's logo file, as the engine cards in Settings → Engine use them. */
const VENDOR_LOGO = /\/logos\/ai-major\//;

test.describe('Neutral Agent and Artifacts', () => {
  let stubDir = '';
  let claude: ManagedAgent | undefined;
  let previousDefault = '';
  let overridesBefore: { command_override?: string; env_override?: unknown[] } = {};
  /** The chat started on the guid page with the default Agent, reused by the artifact test. */
  let chatId = '';
  const cleanups: (() => Promise<unknown>)[] = [];

  /** Points the claude engine at the stub and makes it the default, so the default "Agent" runs on it. */
  async function ensureStubEngine(page: Page): Promise<void> {
    if (claude) return;
    await goToGuid(page);
    const agents = await httpGet<ManagedAgent[]>(page, '/api/agents/management');
    claude =
      agents.find((a) => a.backend === 'claude' && a.agent_source === 'builtin') ??
      agents.find((a) => a.backend === 'claude');
    if (!claude && process.env.CI) throw new Error(NO_CLAUDE_REASON);
    test.fixme(!claude, NO_CLAUDE_REASON);
    const engine = claude as ManagedAgent;
    const overridesUrl = `/api/agents/${encodeURIComponent(engine.id)}/overrides`;
    overridesBefore = await httpGet(page, overridesUrl);
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-claude-'));
    await httpInvoke(page, 'PUT', overridesUrl, {
      command_override: writeClaudeStub(stubDir),
      env_override: overridesBefore.env_override ?? [],
    });
    const defaultAgent = (await httpGet<AssistantRow[]>(page, '/api/assistants')).find(
      (a) => a.id === DEFAULT_AGENT_ID
    );
    previousDefault = defaultAgent?.agent_id ?? '';
    await setDefaultEngine(page, engine.id);
    // The default Agent follows the default engine (it is not pinned).
    await expect
      .poll(
        async () =>
          (await httpGet<AssistantRow[]>(page, '/api/assistants')).find((a) => a.id === DEFAULT_AGENT_ID)?.agent_id
      )
      .toBe(engine.id);
  }

  test.afterAll(async ({ page }) => {
    await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
    if (chatId) {
      await httpInvoke(page, 'DELETE', `/api/conversations/${chatId}`).catch(() => undefined);
      fs.rmSync(path.join(E2E_DATA_HOME, 'artifacts', chatId), { recursive: true, force: true });
    }
    if (claude) {
      if (previousDefault && previousDefault !== claude.id)
        await setDefaultEngine(page, previousDefault).catch(() => undefined);
      await httpInvoke(page, 'PUT', `/api/agents/${encodeURIComponent(claude.id)}/overrides`, {
        command_override: overridesBefore.command_override ?? '',
        env_override: overridesBefore.env_override ?? [],
      }).catch(() => undefined);
    }
    if (stubDir) fs.rmSync(stubDir, { recursive: true, force: true });
  });

  test('new chat shows "Agent" and no vendor name anywhere in the chat chrome', async ({ electronApp, page }) => {
    test.setTimeout(150_000);
    await ensureStubEngine(page);
    await goToGuid(page);
    const pill = page.locator(`[data-assistant-id="${DEFAULT_AGENT_ID}"]`).first();
    await pill.click();
    await expect(
      page.locator(`[data-assistant-id="${DEFAULT_AGENT_ID}"][data-assistant-selected="true"]`)
    ).toBeVisible();
    chatId = await sendMessageFromGuid(page, 'hello');
    expect(await waitForAiReply(page, 60_000)).toContain(STUB_REPLY);

    // The chat runs on the claude engine, and still shows only "Agent".
    const chat = await httpGet<{ assistant?: AssistantRow; extra?: { backend?: string } }>(
      page,
      `/api/conversations/${chatId}`
    );
    expect(chat.assistant?.id).toBe(DEFAULT_AGENT_ID);
    expect(chat.extra?.backend).toBe('claude');
    const textarea = page.locator('textarea').first();
    await expect(textarea).toHaveAttribute('placeholder', /^Message the agent/);
    const shown = [...(await chromeText(page, '.app-titlebar')), ...(await chromeText(page, '#root main, #root'))];
    expect(shown.filter((text) => VENDOR_TEXT.test(text) || VENDOR_LOGO.test(text))).toEqual([]);
    // The header, the reply's sender and the status line name the Agent: the robot, never an engine logo.
    await expect(page.locator('#root .i-icon-robot').first()).toBeVisible();

    // A chat on the engine's own entry (named and drawn after its vendor) shows the neutral Agent too.
    const engineChat = await openNewChat(page, `bare:${(claude as ManagedAgent).id}`, 'E2E engine entry chat');
    try {
      await expect(page.getByText('E2E engine entry chat', { exact: true }).first()).toBeVisible();
      const engineChrome = [...(await chromeText(page, '.app-titlebar')), ...(await chromeText(page, '#root'))];
      expect(engineChrome.filter((text) => VENDOR_TEXT.test(text) || VENDOR_LOGO.test(text))).toEqual([]);
    } finally {
      await httpInvoke(page, 'DELETE', `/api/conversations/${engineChat}`).catch(() => undefined);
      await openChat(page, chatId);
    }

    // The mobile titlebar brand (narrow window) names the chat and draws the Agent, not the engine.
    const size = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('devtools://'));
      const [width, height] = win?.getSize() ?? [0, 0];
      win?.setSize(420, height);
      return { width, height };
    });
    try {
      const brand = page.locator('.app-titlebar__brand-mobile');
      await expect(brand).toBeVisible({ timeout: 10_000 });
      const brandText = await chromeText(page, '.app-titlebar__brand-mobile');
      expect(brandText.filter((text) => VENDOR_TEXT.test(text) || VENDOR_LOGO.test(text))).toEqual([]);
      await expect(brand.locator('.i-icon-robot')).toBeVisible();
    } finally {
      await electronApp.evaluate(({ BrowserWindow }, { width, height }) => {
        BrowserWindow.getAllWindows()
          .find((w) => !w.webContents.getURL().startsWith('devtools://'))
          ?.setSize(width, height);
      }, size);
    }
  });

  test('an artifact created through the artifacts MCP shows a card; Open loads it in the browser pane', async ({
    electronApp,
    page,
  }) => {
    test.setTimeout(120_000);
    test.skip(!chatId, 'Needs the chat from the previous test');
    await openChat(page, chatId);

    // The agent's MCP child creates the artifact for this chat; the stub then reports that call as its turn.
    const artifacts = await connectMcp(electronApp, 'artifacts', chatId);
    cleanups.push(() => artifacts.close());
    const input = {
      title: 'Sales dashboard',
      kind: 'html',
      content: '<!doctype html><h1 id="headline">Q3 sales</h1><p>Total: 1,234</p>',
    };
    const result = await callTool(artifacts, 'create', input);
    const created = JSON.parse(result) as { id: string; version: number; url: string };
    expect(created.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]{22}$/);
    fs.writeFileSync(
      path.join(stubDir, 'turn.json'),
      JSON.stringify({ tool: { name: 'mcp__aionui-artifacts__create', input, result } } satisfies StubTurn)
    );
    const textarea = page.locator('textarea').first();
    await textarea.fill('make a sales dashboard');
    await textarea.press('Enter');

    // The card sits outside the folded steps.
    const group = page.locator('.tool-group-summary').filter({ hasText: 'Sales dashboard' });
    await expect(group).toBeVisible({ timeout: 60_000 });
    await expect(group.locator('.tool-group-summary__body')).toHaveCount(0);
    await expect(group).toContainText('v1');

    await group.getByRole('button', { name: 'Open' }).click();
    const href = `${created.url}/v/1`;
    const tab = () =>
      electronApp.evaluate(
        ({ webContents }, url) =>
          webContents.getAllWebContents().find((wc) => wc.getType() === 'webview' && wc.getURL() === url)?.id ?? 0,
        href
      );
    await expect.poll(tab, { message: `a pane tab at ${href}`, timeout: 20_000 }).toBeGreaterThan(0);
    // The artifact page runs in a sandboxed frame of its shell, so read every frame's text.
    const pageText = async () =>
      electronApp.evaluate(
        async ({ webContents }, id) => {
          const frames = webContents.fromId(id)?.mainFrame.framesInSubtree ?? [];
          const texts = await Promise.all(frames.map((f) => f.executeJavaScript('document.body?.innerText ?? ""')));
          return texts.join('\n');
        },
        await tab()
      );
    await expect.poll(pageText, { timeout: 20_000 }).toContain('Q3 sales');

    // The chat's agent got the chat id and the artifact server from AionCore, as its MCP children need them.
    const runs = fs
      .readFileSync(path.join(stubDir, 'runs.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StubRun)
      .filter((run) => run.argv.includes('--mcp-config') && run.env.AIONUI_CONVERSATION_ID === chatId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].env.AION_ARTIFACTS_URL).toBe(new URL(created.url).origin);
    expect(runs[0].argv.join(' ')).toContain('builtin-mcp-artifacts');
  });

  test('Teams, Pet, Butler and Feedback entry points are absent', async ({ electronApp, page }) => {
    await goToGuid(page);
    const shell = [...(await chromeText(page, '.app-titlebar')), ...(await chromeText(page, '#root'))];
    expect(shell.filter((text) => REMOVED_FEATURES.test(text))).toEqual([]);
    await expect(page.locator('[data-assistant-id="aionui-assistant"]')).toHaveCount(0);

    // Old routes lead nowhere.
    const base = page.url().split('#')[0];
    await page.goto(`${base}#/team/e2e-team`);
    await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/guid/);
    await page.goto(`${base}#/settings/pet`);
    await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain('pet');
    const settings = await chromeText(page, '#root');
    expect(settings.filter((text) => REMOVED_FEATURES.test(text))).toEqual([]);

    // Butler is not an Agent the user can pick or edit.
    await openAgentsPage(page);
    // The page opens on My VA Bots; the default agent is listed under Enabled.
    await page.getByTestId('settings-tab-enabled').click();
    await expect(page.locator(`[data-testid="enabled-assistant-row-${DEFAULT_AGENT_ID}"]`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid*="aionui-assistant"]')).toHaveCount(0);
    await page.getByTestId('settings-tab-official').click();
    await expect(page.locator('[data-testid*="word-creator"]').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid*="aionui-assistant"]')).toHaveCount(0);
    expect((await chromeText(page, '#root')).filter((text) => REMOVED_FEATURES.test(text))).toEqual([]);
    // No pet window was started: the app has only its main window.
    const windows = await electronApp.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => !w.webContents.getURL().startsWith('devtools://')).length
    );
    expect(windows).toBe(1);
  });

  test('titlebar Search opens history and Back returns to the previous chat', async ({ page }) => {
    await goToGuid(page);
    const names = ['E2E history first', 'E2E history second'];
    const [first, second] = await Promise.all(
      names.map(async (name) => {
        const { id } = await httpInvoke<{ id: string }>(page, 'POST', '/api/conversations', {
          name,
          assistant: { id: DEFAULT_AGENT_ID },
          extra: { workspace: os.tmpdir(), custom_workspace: true },
        });
        cleanups.push(() => httpInvoke(page, 'DELETE', `/api/conversations/${id}`));
        return id;
      })
    );
    const openFromHistory = async (id: string, name: string) => {
      await openHistoryPanel(page);
      const row = page.locator(`#c-${id}`);
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.click();
      await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/conversation/${id}`);
      // The hash moves first; the chat (and the titlebar's record of the visit) renders once its data has loaded.
      await expect(page.locator('.arco-drawer:visible')).toHaveCount(0);
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    };
    await openFromHistory(first, names[0]);
    await openFromHistory(second, names[1]);

    await page.locator('.app-titlebar').getByRole('button', { name: 'Back', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/conversation/${first}`);
    await page.locator('.app-titlebar').getByRole('button', { name: 'Forward', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/conversation/${second}`);
  });

  test.describe('a user-made Agent', () => {
    let servers: FixtureServers;
    /** An id with a ':' like real generated ones (bare:632f31d2): exercises percent-encoded rule and notes paths. */
    const agentId = `e2e:sales-${process.pid}`;
    let agentChat = '';

    test.beforeAll(async () => {
      servers = await startFixtureServers();
    });

    test.afterAll(async ({ page }) => {
      if (agentChat) await httpInvoke(page, 'DELETE', `/api/conversations/${agentChat}`).catch(() => undefined);
      await httpInvoke(page, 'DELETE', `/api/assistants/${encodeURIComponent(agentId)}`).catch(() => undefined);
      fs.rmSync(path.join(E2E_DATA_HOME, 'agent-notes', `${encodeURIComponent(agentId)}.json`), {
        force: true,
      });
      await servers?.close();
    });

    /** Creates the Agent on the claude engine (or any engine) and a chat with it; resolves to the chat id. */
    async function ensureAgentChat(page: Page): Promise<string> {
      if (agentChat) return agentChat;
      await goToGuid(page);
      const engines = await httpGet<ManagedAgent[]>(page, '/api/agents/management');
      const engine = engines.find((a) => a.backend === 'claude') ?? engines[0];
      await httpInvoke(page, 'POST', '/api/assistants', { id: agentId, name: 'Sales Helper', agent_id: engine.id });
      agentChat = await openNewChat(page, agentId, 'E2E Sales Helper chat');
      return agentChat;
    }

    test("an Agent tab opens in that Agent's profile; a Personal login is not visible there", async ({
      electronApp,
      page,
    }) => {
      const conversationId = await ensureAgentChat(page);
      const browser = await connectMcp(electronApp, 'browser', conversationId);
      const url = `${servers.originA}/confirm.html`;
      try {
        const opened = JSON.parse(await callTool(browser, 'tabs', { action: 'open', url })) as { tab: string };
        const wc = Number(/^wc-(\d+)$/.exec(opened.tab)?.[1]);
        const hash = createHash('sha256').update(agentId).digest('hex').slice(0, 32);
        const seen = await electronApp.evaluate(
          async ({ session, webContents }, { id, target }) => {
            const tab = webContents.fromId(id);
            if (!tab) throw new Error(`no tab ${id}`);
            const personal = session.fromPartition('persist:aionui-browser');
            await personal.cookies.set({ url: target, name: 'personal_login', value: '1' });
            try {
              return {
                storagePath: tab.session.storagePath,
                inPersonal: (await personal.cookies.get({ url: target, name: 'personal_login' })).length,
                inAgent: (await tab.session.cookies.get({ url: target, name: 'personal_login' })).length,
                pageCookie: await tab.executeJavaScript('document.cookie'),
              };
            } finally {
              await personal.cookies.remove(target, 'personal_login');
            }
          },
          { id: wc, target: url }
        );
        // This chat's Agent, not the shared default Agent profile.
        expect(seen.storagePath).toMatch(new RegExp(`Partitions[\\\\/]aionui-agent-${hash}$`));
        expect(seen.inPersonal).toBe(1);
        expect(seen.inAgent).toBe(0);
        expect(seen.pageCookie).not.toContain('personal_login');
        await callTool(browser, 'tabs', { action: 'close', tab: opened.tab });
      } finally {
        await browser.close();
      }
    });

    test("notes.add through the notes MCP shows the note in the Agent editor's Notebook and in the rule block", async ({
      electronApp,
      page,
    }) => {
      const conversationId = await ensureAgentChat(page);
      const notes = await connectMcp(electronApp, 'notes', conversationId);
      const text = 'The user wants sales numbers as a table, newest month first.';
      try {
        const saved = JSON.parse(await callTool(notes, 'add', { text })) as { saved: boolean; source: string };
        expect(saved).toMatchObject({ saved: true, source: 'agent' });
      } finally {
        await notes.close();
      }

      const rule = () =>
        httpInvoke<string>(page, 'POST', '/api/skills/assistant-rule/read', { assistant_id: agentId, locale: 'en-US' });
      await expect.poll(rule).toContain('<!-- aion-notes:start -->');
      expect(await rule()).toContain(text);

      await openAgentEditor(page, agentId);
      await expect(page.locator('[data-testid="agent-note"]').filter({ hasText: text })).toBeVisible({
        timeout: 10_000,
      });
      await page.keyboard.press('Escape');
    });

    test("saving empty instructions deletes the rule of an Agent whose id has a ':' (percent-encoded delete)", async ({
      page,
    }) => {
      await ensureAgentChat(page);
      const read = (locale: string) =>
        httpInvoke<string>(page, 'POST', '/api/skills/assistant-rule/read', { assistant_id: agentId, locale });
      await httpInvoke(page, 'POST', '/api/skills/assistant-rule/write', {
        assistant_id: agentId,
        locale: 'ja-JP',
        content: 'Japanese instructions to be cleared',
      });
      expect(await read('ja-JP')).toContain('Japanese instructions to be cleared');

      // What the Agent editor's Save sends for empty instructions.
      const reply = await invokeBridge<{ success: boolean; msg?: string }>(page, 'agent-browser.ensure-agent-rule', {
        assistantId: agentId,
        locale: 'en-US',
        content: '',
      });
      expect(reply, JSON.stringify(reply)).toMatchObject({ success: true });
      // The delete reached the backend: every locale's rule went, then main wrote back only the managed blocks.
      await expect.poll(() => read('ja-JP')).not.toContain('Japanese instructions');
      expect(await read('en-US')).not.toContain('Japanese instructions');
    });
  });
});
