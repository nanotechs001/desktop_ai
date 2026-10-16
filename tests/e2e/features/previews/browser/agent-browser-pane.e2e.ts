/**
 * Agents in the browser pane, end to end.
 *
 * Drives the built `aionui-browser` MCP server (out/main/builtin-mcp-browser.js) the way an agent does: spawned
 * over stdio with the app's relay url and token, called with the MCP SDK client. Its calls go through the real
 * relay in main into the pane's `<webview>` tabs, so these tests cover ownership, take-over, the ConfirmGate
 * prompt and the action overlay together. Pages come from the integration fixtures, served on two loopback
 * origins so the builder's iframe is cross-origin (an OOPIF).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ElectronApplication, Page } from '@playwright/test';
import { startFixtureServers, type FixtureServers } from '../../../../integration/agentBrowser/helpers/fixtureServer';
import { test, expect } from '../../../fixtures';
import {
  findAssistantIdForBackend,
  goToGuid,
  httpGet,
  httpInvoke,
  selectAgent,
  sendMessageFromGuid,
} from '../../../helpers';

const MCP_SCRIPT = path.resolve(__dirname, '../../../../../out/main/builtin-mcp-browser.js');
const BRIDGE_EVENT_KEY = 'office-ai-bridge-adapter';
const OBSERVE_TIMEOUT_MS = 15_000;
const OBSERVE_RETRY_MS = 250;
const NO_ASSISTANT_REASON =
  'Needs an installed Claude assistant: the browser pane only renders inside a conversation, which needs one';

type StepResult = { op: string; result: string; reason?: string };
type ActReply = { results: StepResult[]; stopped?: string };
type TabEntry = { tab: string; owner: string; url: string };
type ToolReply = { text: string; isError: boolean };

/** One tool call; the text of its first content item. */
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const reply = await client.callTool({ name, arguments: args });
  const [first] = reply.content as { type: string; text?: string }[];
  return { text: first?.text ?? '', isError: reply.isError === true };
}

const act = async (client: Client, actions: Record<string, unknown>[]): Promise<ActReply> =>
  JSON.parse((await call(client, 'act', { actions })).text) as ActReply;

/** The id of the `role "label"` control observed in the frame labelled `frame` (a frame's origin when unnamed). */
const controlId = (observation: string, role: string, label: string, frame: string): string | null => {
  const suffix = ` · in: ${JSON.stringify(frame)}`;
  const line = observation
    .split('\n')
    .find((l) => l.includes(`] ${role} ${JSON.stringify(label)}`) && l.endsWith(suffix));
  return line ? (/^\[(f\d+:\d+)\]/.exec(line)?.[1] ?? null) : null;
};

/** Observes until the control is listed: an OOPIF attaches a little after the top document loads. */
async function observeControl(
  client: Client,
  role: string,
  label: string,
  frame: string,
  deadline = Date.now() + OBSERVE_TIMEOUT_MS
): Promise<string> {
  const observation = (await call(client, 'observe', { text: false })).text;
  const id = controlId(observation, role, label, frame);
  if (id) return id;
  if (Date.now() > deadline) throw new Error(`no ${role} "${label}" in ${frame}; last observe:\n${observation}`);
  await new Promise((resolve) => setTimeout(resolve, OBSERVE_RETRY_MS));
  return observeControl(client, role, label, frame, deadline);
}

/** Runs `expression` in the frame of the tab `webContentsId` whose url starts with `frameUrl` (OOPIFs included). */
async function evalInFrame(
  electronApp: ElectronApplication,
  webContentsId: number,
  frameUrl: string,
  expression: string
): Promise<unknown> {
  return electronApp.evaluate(
    async ({ webContents }, { id, url, code }) => {
      const frame = webContents.fromId(id)?.mainFrame.framesInSubtree.find((f) => f.url.startsWith(url));
      if (!frame) throw new Error(`no frame at ${url}`);
      return frame.executeJavaScript(code);
    },
    { id: webContentsId, url: frameUrl, code: expression }
  );
}

type Box = { x: number; y: number; width: number; height: number };

/** True when two boxes share some area. */
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const webContentsIdOf = (tab: string): number => Number(/^wc-(\d+)$/.exec(tab)?.[1]);

/** Opens a user tab through the same event target=_blank uses; resolves to its webContents id. */
async function openUserTab(electronApp: ElectronApplication, url: string): Promise<number> {
  await electronApp.evaluate(
    ({ BrowserWindow }, { key, target }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('devtools://'));
      win?.webContents.send(
        key,
        JSON.stringify({ name: 'browser.open-tab-requested', data: { url: target, background: false } })
      );
    },
    { key: BRIDGE_EVENT_KEY, target: url }
  );
  const find = () =>
    electronApp.evaluate(
      ({ webContents }, target) =>
        webContents.getAllWebContents().find((wc) => wc.getType() === 'webview' && wc.getURL() === target)?.id ?? 0,
      url
    );
  await expect.poll(find, { message: `a user tab at ${url}`, timeout: 20_000 }).toBeGreaterThan(0);
  return find();
}

async function closeUserTab(electronApp: ElectronApplication, webContentsId: number): Promise<void> {
  await electronApp.evaluate(
    ({ BrowserWindow }, { key, id }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('devtools://'));
      win?.webContents.send(key, JSON.stringify({ name: 'browser.close-tab-requested', data: { webContentsId: id } }));
    },
    { key: BRIDGE_EVENT_KEY, id: webContentsId }
  );
}

/** Creates a conversation (never messaged) and opens it, which mounts the browser pane. */
async function openConversation(page: Page, assistantId: string): Promise<string> {
  const { id } = await httpInvoke<{ id: string }>(page, 'POST', '/api/conversations', {
    name: 'E2E agent browser pane',
    assistant: { id: assistantId },
    extra: { workspace: os.tmpdir(), custom_workspace: true, session_mode: 'default' },
  });
  await page.goto(`${page.url().split('#')[0]}#/conversation/${id}`);
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 });
  return id;
}

/** Creates a conversation in another project (its own workspace) and opens it; resolves to its id. */
async function openOtherProjectChat(page: Page): Promise<string> {
  const { id } = await httpInvoke<{ id: string }>(page, 'POST', '/api/conversations', {
    name: 'E2E agent browser pane (other project)',
    assistant: { id: (await findAssistantIdForBackend(page, 'claude')) ?? '' },
    extra: { workspace: fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-other-')), custom_workspace: true },
  });
  await page.goto(`${page.url().split('#')[0]}#/conversation/${id}`);
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 });
  return id;
}

/** Counts mousedown events in the frame it runs in (installing the counter on first use); returns the count. */
const MOUSE_DOWNS = `(() => {
  if (window.mouseDowns === undefined) {
    window.mouseDowns = 0;
    addEventListener('mousedown', () => { window.mouseDowns++; }, true);
  }
  return window.mouseDowns;
})()`;

/** Spawns the built MCP server exactly as an agent would, with the relay env main exported for AionCore. */
async function connectAgent(electronApp: ElectronApplication): Promise<Client> {
  if (!fs.existsSync(MCP_SCRIPT)) {
    throw new Error(`${MCP_SCRIPT} is missing: run \`node scripts/build-mcp-servers.js\` (the e2e globalSetup does).`);
  }
  const relay = await electronApp.evaluate(() => ({
    url: process.env.AION_BROWSER_RELAY_URL ?? '',
    token: process.env.AION_BROWSER_RELAY_TOKEN ?? '',
  }));
  expect(relay.url, 'main exported no relay url (is agent browser control on?)').toMatch(/^ws:\/\/127\.0\.0\.1:\d+/);
  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SCRIPT],
      env: { ...process.env, AION_BROWSER_RELAY_URL: relay.url, AION_BROWSER_RELAY_TOKEN: relay.token } as Record<
        string,
        string
      >,
      stderr: 'inherit',
    })
  );
  return client;
}

test.describe('Agents in the browser pane', () => {
  let servers: FixtureServers;
  let agent: Client | null = null;
  let conversationId = '';
  /** The builder tab the agent opens for each test. */
  let builderTab = '';
  let builderUrl = '';
  let childUrl = '';

  test.beforeAll(async () => {
    servers = await startFixtureServers();
    builderUrl = `${servers.originA}/builder-crossorigin.html`;
    childUrl = `${servers.originB}/child.html`;
  });

  test.afterAll(async ({ page }) => {
    await agent?.close().catch(() => undefined);
    if (conversationId) await httpInvoke(page, 'DELETE', `/api/conversations/${conversationId}`).catch(() => undefined);
    await servers?.close();
  });

  test.beforeEach(async ({ electronApp, page }) => {
    if (!agent) {
      await goToGuid(page);
      const assistantId = await findAssistantIdForBackend(page, 'claude');
      if (!assistantId && process.env.CI) throw new Error(NO_ASSISTANT_REASON);
      test.fixme(!assistantId, NO_ASSISTANT_REASON);
      // tabs open needs the pane mounted, and the pane only renders in an open conversation.
      conversationId = await openConversation(page, assistantId ?? '');
      agent = await connectAgent(electronApp);
    }
    const opened = await call(agent, 'tabs', { action: 'open', url: builderUrl });
    expect(opened.isError, opened.text).toBe(false);
    builderTab = (JSON.parse(opened.text) as { tab: string }).tab;
  });

  test.afterEach(async () => {
    if (agent && builderTab) await call(agent, 'tabs', { action: 'close', tab: builderTab });
    builderTab = '';
  });

  test('tabs.open opens a pane tab marked Agent; observe lists controls in a cross-origin iframe', async ({ page }) => {
    const client = agent as Client;
    expect(builderTab).toMatch(/^wc-\d+$/);
    // The nav bar's Agent badge carries the robot icon; other "Agent" tags in the window do not.
    await expect(page.locator('.arco-tag:visible', { has: page.locator('.i-icon-robot') })).toHaveText('Agent');
    const { tabs } = JSON.parse((await call(client, 'tabs', { action: 'list' })).text) as { tabs: TabEntry[] };
    expect(tabs).toEqual([expect.objectContaining({ tab: builderTab, owner: 'agent', url: builderUrl })]);

    // Both controls live in the child page from the other origin, which Chromium runs out of process.
    await observeControl(client, 'button', 'Publish', servers.originB);
    await observeControl(client, 'textbox', 'Page title', servers.originB);
  });

  test('act clicks inside the OOPIF and the page reacts; the overlay showed the action', async ({
    electronApp,
    page,
  }) => {
    const client = agent as Client;
    const title = await observeControl(client, 'textbox', 'Page title', servers.originB);
    const titleValue = () =>
      evalInFrame(electronApp, webContentsIdOf(builderTab), childUrl, `document.getElementById('title').value`);

    // The highlight lasts 1.5 s, so check it right after the click, and that it sits on the input inside the OOPIF.
    const clicked = await act(client, [{ op: 'click', target: title }]);
    expect(clicked.results.map((r) => r.result)).toEqual(['done']);
    const highlight = page.getByTestId('agent-highlight');
    await expect(highlight).toBeVisible();
    const highlightBox = (await highlight.boundingBox()) as Box;
    const pane = (await page.locator('webview:visible').boundingBox()) as Box;
    const input = (await evalInFrame(
      electronApp,
      webContentsIdOf(builderTab),
      childUrl,
      `(() => { const r = document.getElementById('title').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`
    )) as Box;
    // The OOPIF sits at (30, 20) in the page; the input's rect is in the OOPIF's own coordinates.
    const inputOnScreen = { ...input, x: pane.x + 30 + input.x, y: pane.y + 20 + input.y };
    expect(overlaps(highlightBox, inputOnScreen), JSON.stringify({ highlightBox, inputOnScreen })).toBe(true);

    // type is select-all (a keyDown) plus insertText: the agent's own keys must not count as the user taking over.
    const typed = await act(client, [
      {
        op: 'type',
        target: await observeControl(client, 'textbox', 'Page title', servers.originB),
        text: 'Spring Sale',
      },
    ]);
    expect(typed.results.map((r) => r.result)).toEqual(['done']);
    await expect.poll(titleValue).toBe('Spring Sale');

    // A keyDown that carries text (Space) must not leave a stray Char report that pauses the tab either.
    // Ids last only until the page changes, and typing changed it: observe again, as an agent does.
    const fresh = await observeControl(client, 'textbox', 'Page title', servers.originB);
    const pressed = await act(client, [{ op: 'press', key: 'Space', target: fresh }]);
    expect(pressed.results.map((r) => r.result)).toEqual(['done']);
    await expect.poll(titleValue).toBe('Spring Sale ');
    await expect(page.getByText('Paused: you took over.')).toHaveCount(0);
    const again = await act(client, [
      { op: 'hover', target: await observeControl(client, 'textbox', 'Page title', servers.originB) },
    ]);
    expect(again.results.map((r) => r.result)).toEqual(['done']);
  });

  test('user click on the agent tab pauses: next act returns "user took over"; Resume clears it', async ({ page }) => {
    const client = agent as Client;
    const title = await observeControl(client, 'textbox', 'Page title', servers.originB);
    const box = await page.locator('webview:visible').boundingBox();
    expect(box, 'the agent tab has no on-screen box').not.toBeNull();
    const { x, y, width, height } = box as NonNullable<typeof box>;

    // A real click in the AionUi window, on an empty part of the page: what a user's click does.
    await page.mouse.click(x + width - 20, y + height - 20);

    const banner = page.getByText('Paused: you took over.');
    await expect(banner).toBeVisible();
    const paused = await act(client, [{ op: 'hover', target: title }]);
    expect(paused.results[0].result).toBe('paused');
    expect(paused.stopped).toContain('The user took over this tab');

    await page.getByRole('button', { name: 'Resume agent' }).click();
    await expect(banner).toBeHidden();
    const resumed = await act(client, [{ op: 'hover', target: title }]);
    expect(resumed.results.map((r) => r.result)).toEqual(['done']);
  });

  test('a "Publish" click prompts; Deny blocks it', async ({ electronApp, page }) => {
    const client = agent as Client;
    const clicks = () => evalInFrame(electronApp, webContentsIdOf(builderTab), childUrl, 'window.clicks');
    const prompt = page.locator('.arco-modal').filter({ hasText: 'Allow this agent action?' });

    const denied = act(client, [
      { op: 'click', target: await observeControl(client, 'button', 'Publish', servers.originB) },
    ]);
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('Publish');
    await prompt.getByRole('button', { name: 'Deny' }).click();
    expect((await denied).results[0].result).toBe('denied');
    await expect(prompt).toBeHidden();
    expect(await clicks()).toBe(0);

    const allowed = act(client, [
      { op: 'click', target: await observeControl(client, 'button', 'Publish', servers.originB) },
    ]);
    await expect(prompt).toBeVisible();
    // Allow arms itself a moment after the prompt opens; the click waits for it.
    await prompt.getByRole('button', { name: 'Allow' }).click();
    expect((await allowed).results[0].result).toBe('done');
    await expect.poll(clicks).toBe(1);
  });

  test('an agent keeps clicking and typing in its tab while another chat is on screen or the panel is closed', async ({
    electronApp,
    page,
  }) => {
    const client = agent as Client;
    const wc = webContentsIdOf(builderTab);
    const titleValue = () => evalInFrame(electronApp, wc, childUrl, `document.getElementById('title').value`);
    const clicks = () => evalInFrame(electronApp, wc, childUrl, 'window.clicks');
    // The agent's tab is in the layer, hidden (and never inert: inert would reach into the guest and swallow input).
    const hiddenNotInert = () =>
      page.evaluate(
        (id) =>
          Array.from(document.querySelectorAll<HTMLElement>('[data-browser-tab]')).some((wrapper) => {
            const webview = wrapper.querySelector('webview') as (HTMLElement & { getWebContentsId(): number }) | null;
            return (
              wrapper.style.visibility !== 'visible' &&
              webview?.getWebContentsId() === id &&
              !webview.closest('[inert]')
            );
          }),
        wc
      );
    const prompt = page.locator('.arco-modal').filter({ hasText: 'Allow this agent action?' });
    await observeControl(client, 'textbox', 'Page title', servers.originB); // the OOPIF is attached
    // Another project's chat on screen: the agent's tab is hidden in the background.
    const otherChat = await openOtherProjectChat(page);
    try {
      await expect.poll(hiddenNotInert).toBe(true);

      const clicked = act(client, [
        { op: 'click', target: await observeControl(client, 'button', 'Publish', servers.originB) },
      ]);
      await expect(prompt).toBeVisible();
      await prompt.getByRole('button', { name: 'Allow' }).click();
      expect((await clicked).results.map((r) => r.result)).toEqual(['done']);
      await expect.poll(clicks).toBe(1);
      const typed = await act(client, [
        { op: 'type', target: await observeControl(client, 'textbox', 'Page title', servers.originB), text: 'In B' },
      ]);
      expect(typed.results.map((r) => r.result)).toEqual(['done']);
      await expect.poll(titleValue).toBe('In B');

      // No panel at all (the new-chat page).
      await page.goto(`${page.url().split('#')[0]}#/guid`);
      await expect.poll(hiddenNotInert).toBe(true);
      const typedAgain = await act(client, [
        {
          op: 'type',
          target: await observeControl(client, 'textbox', 'Page title', servers.originB),
          text: 'Panel closed',
        },
      ]);
      expect(typedAgain.results.map((r) => r.result)).toEqual(['done']);
      await expect.poll(titleValue).toBe('Panel closed');
      const hover = await act(client, [
        { op: 'hover', target: await observeControl(client, 'textbox', 'Page title', servers.originB) },
      ]);
      expect(hover.results.map((r) => r.result)).toEqual(['done']); // never paused
    } finally {
      await httpInvoke(page, 'DELETE', `/api/conversations/${otherChat}`).catch(() => undefined);
      await page.goto(`${page.url().split('#')[0]}#/conversation/${conversationId}`);
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 });
    }
  });

  test('an agent clicking in its hidden tab leaves the focus, and the keys, in the chat the user is typing in', async ({
    electronApp,
    page,
  }) => {
    const client = agent as Client;
    const wc = webContentsIdOf(builderTab);
    const titleValue = () => evalInFrame(electronApp, wc, childUrl, `document.getElementById('title').value`);
    await observeControl(client, 'textbox', 'Page title', servers.originB); // the OOPIF is attached
    const otherChat = await openOtherProjectChat(page);
    try {
      await electronApp.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('devtools://'));
        win?.show();
        win?.focus();
        win?.webContents.focus();
      });
      const windowFocused = await page.evaluate(() => document.hasFocus());
      test.skip(
        !windowFocused,
        'The AionUi window gets no OS focus on this machine, so no focus events fire; the jsdom tests cover the guard'
      );
      const chat = page.locator('textarea').first();
      await chat.focus();

      const clicked = await act(client, [
        { op: 'click', target: await observeControl(client, 'textbox', 'Page title', servers.originB) },
      ]);
      expect(clicked.results.map((r) => r.result)).toEqual(['done']);
      // The click landed: the guest's own focus moved to its input. The app's focus must not have followed it.
      await expect.poll(() => evalInFrame(electronApp, wc, childUrl, 'document.activeElement?.id')).toBe('title');

      expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
      await page.keyboard.type('still typing');
      await expect(chat).toHaveValue(/still typing/);
      expect(await titleValue()).toBe('');
    } finally {
      await httpInvoke(page, 'DELETE', `/api/conversations/${otherChat}`).catch(() => undefined);
      await page.goto(`${page.url().split('#')[0]}#/conversation/${conversationId}`);
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 });
    }
  });

  test('a user click over an agent tab hidden behind the app never reaches it or pauses it', async ({
    electronApp,
    page,
  }) => {
    const client = agent as Client;
    const wc = webContentsIdOf(builderTab);
    await observeControl(client, 'button', 'Publish', servers.originB); // the OOPIF is attached
    const mouseDowns = async () =>
      Number(await evalInFrame(electronApp, wc, builderUrl, MOUSE_DOWNS)) +
      Number(await evalInFrame(electronApp, wc, childUrl, MOUSE_DOWNS));
    expect(await mouseDowns()).toBe(0);
    try {
      await goToGuid(page); // no panel: the layer sits behind the app
      const layer = () =>
        page.evaluate(() => {
          const element = document.querySelector<HTMLElement>('[data-browser-tab]')?.parentElement;
          const rect = element?.getBoundingClientRect();
          return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height, z: element?.style.zIndex };
        });
      await expect.poll(async () => (await layer())?.z).toBe('-1');
      const box = (await layer()) as Box;

      // Over the page, and over the OOPIF's Publish button (iframe at (30, 20), Publish at (10, 20) in it, nav bar 40px).
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.click(box.x + 30 + 10 + 20, box.y + 40 + 20 + 20 + 10);

      const hover = await act(client, [
        { op: 'hover', target: await observeControl(client, 'button', 'Publish', servers.originB) },
      ]);
      expect(hover.results.map((r) => r.result)).toEqual(['done']); // not paused: no user input reached the tab
      expect(await mouseDowns()).toBe(0);
    } finally {
      await page.goto(`${page.url().split('#')[0]}#/conversation/${conversationId}`);
      await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 });
    }
  });

  test('an unshared user tab is not listed/accessible to the agent', async ({ electronApp }) => {
    const client = agent as Client;
    const userTab = await openUserTab(electronApp, `${servers.originA}/confirm.html`);
    try {
      const { tabs } = JSON.parse((await call(client, 'tabs', { action: 'list' })).text) as { tabs: TabEntry[] };
      expect(tabs.map((t) => t.tab)).toEqual([builderTab]);

      const observed = await call(client, 'observe', { tab: `wc-${userTab}` });
      expect(observed.isError).toBe(true);
      const switched = await call(client, 'tabs', { action: 'switch', tab: `wc-${userTab}` });
      expect(switched.isError).toBe(true);
    } finally {
      await closeUserTab(electronApp, userTab);
    }
  });

  test("the agent's tab lives in its Agent profile: a cookie set in Personal is not there", async ({ electronApp }) => {
    const wc = webContentsIdOf(builderTab);
    // This MCP names no chat, so its tabs use the shared default Agent profile (ruling N-15 names the partition).
    const hash = createHash('sha256').update('aion-default-agent').digest('hex').slice(0, 32);
    const seen = await electronApp.evaluate(
      async ({ session, webContents }, { id, url }) => {
        const tab = webContents.fromId(id);
        if (!tab) throw new Error(`no tab ${id}`);
        const personal = session.fromPartition('persist:aionui-browser');
        await personal.cookies.set({ url, name: 'personal_only', value: '1' });
        try {
          return {
            onPersonal: tab.session === personal,
            storagePath: tab.session.storagePath,
            inPersonal: (await personal.cookies.get({ url, name: 'personal_only' })).length,
            inAgent: (await tab.session.cookies.get({ url, name: 'personal_only' })).length,
            pageCookie: await tab.executeJavaScript('document.cookie'),
          };
        } finally {
          await personal.cookies.remove(url, 'personal_only');
        }
      },
      { id: wc, url: builderUrl }
    );

    expect(seen.onPersonal).toBe(false);
    expect(seen.storagePath).toMatch(new RegExp(`Partitions[\\\\/]aionui-agent-${hash}$`));
    expect(seen.inPersonal).toBe(1);
    expect(seen.inAgent).toBe(0);
    expect(seen.pageCookie).not.toContain('personal_only');
  });
});

/**
 * Whether a conversation created on the Guid page (the renderer's real create path, which also sends the assistant's
 * conversation_overrides.mcp_ids) hands its agent the browser server: AionCore must not filter the session server
 * out. The claude command is pointed at a stub that records its arguments and exits, so no real Claude session starts.
 */
test.describe('A new conversation gets the browser tools', () => {
  test('the spawned claude gets aionui-browser in --mcp-config', async ({ page }) => {
    test.setTimeout(120_000);
    await goToGuid(page);
    const agents = await httpGet<{ id: string; backend?: string; agent_source?: string }[]>(
      page,
      '/api/agents/management'
    );
    const claude =
      agents.find((a) => a.backend === 'claude' && a.agent_source === 'builtin') ??
      agents.find((a) => a.backend === 'claude');
    if (!claude && process.env.CI) throw new Error(NO_ASSISTANT_REASON);
    test.fixme(!claude, NO_ASSISTANT_REASON);
    const overridesUrl = `/api/agents/${encodeURIComponent(claude?.id ?? '')}/overrides`;
    const before = await httpGet<{ command_override?: string; env_override?: unknown[] }>(page, overridesUrl);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-claude-'));
    const argsFile = path.join(dir, 'args.jsonl');
    const stub = path.join(dir, 'claude');
    fs.writeFileSync(
      stub,
      `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
        `if (process.argv.includes('--version')) console.log('2.1.0 (Claude Code)');\n`,
      { mode: 0o755 }
    );
    let conversationId = '';
    try {
      await httpInvoke(page, 'PUT', overridesUrl, { command_override: stub, env_override: before.env_override ?? [] });
      await selectAgent(page, 'claude');
      conversationId = await sendMessageFromGuid(page, 'hello');

      const sessionArgs = (): string[] | undefined =>
        (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : '')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[])
          .find((args) => args.includes('--mcp-config'));
      await expect.poll(() => sessionArgs() !== undefined, { timeout: 60_000 }).toBe(true);
      const args = sessionArgs() as string[];
      const value = args[args.indexOf('--mcp-config') + 1];
      const config = value.trim().startsWith('{') ? value : fs.readFileSync(value, 'utf8');
      const servers = (JSON.parse(config) as { mcpServers: Record<string, { args?: string[] }> }).mcpServers;
      expect(Object.keys(servers)).toContain('aionui-browser');
      expect(servers['aionui-browser'].args?.join(' ')).toContain('builtin-mcp-browser');
    } finally {
      await httpInvoke(page, 'PUT', overridesUrl, {
        command_override: before.command_override ?? '',
        env_override: before.env_override ?? [],
      });
      if (conversationId)
        await httpInvoke(page, 'DELETE', `/api/conversations/${conversationId}`).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
