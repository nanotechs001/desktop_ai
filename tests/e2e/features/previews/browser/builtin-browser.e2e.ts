/**
 * Built-in browser — behaves like a regular browser.
 *
 * Drives the real in-app browser (the `<webview>` on partition `persist:aionui-browser`) against a
 * local fixture server, covering the flows most likely to regress silently: native form POSTs,
 * target=_blank tabs, window.open popups with window.opener, downloads, permission prompts and
 * Cmd/Ctrl+R reaching the page instead of the AionUi window.
 *
 * How it drives the guests: Playwright's Electron support lists every `<webview>` guest and popup
 * window in `electronApp.windows()` as a Page, so the tests use ordinary Page APIs on them.
 * A tab is opened through the same main -> renderer event (`browser.open-tab-requested`) that
 * target=_blank and window.open use, which ends in `PreviewContext.openBrowserTab`. The preview
 * panel only renders inside a conversation, so one is created (never messaged) for the suite.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, e2eBrowserDownloadsDir } from '../../../fixtures';
import { findAssistantIdForBackend, goToGuid } from '../../../helpers';

/** Cmd on macOS, Ctrl elsewhere — the platform's browser shortcut modifier. */
const MOD = process.platform === 'darwin' ? 'meta' : 'control';
const BRIDGE_EVENT_KEY = 'office-ai-bridge-adapter';
const OPEN_TAB_EVENT = 'browser.open-tab-requested';

type Fixture = {
  origin: string;
  /** Raw body and content type of the last POST /login. */
  lastLoginPost: () => { body: string; contentType: string } | null;
  close: () => Promise<void>;
};

const html = (body: string, title = 'fixture'): string => `<!doctype html><title>${title}</title>${body}`;

/** A local site with one page per scenario; random port on 127.0.0.1 (a secure context for geolocation). */
async function startFixtureServer(): Promise<Fixture> {
  let reloads = 0;
  let loginPost: { body: string; contentType: string } | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (body: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };

    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => {
        loginPost = { body, contentType: req.headers['content-type'] ?? '' };
        const user = new URLSearchParams(body).get('user') ?? '';
        send('', 302, { location: '/home', 'set-cookie': `user=${encodeURIComponent(user)}; Path=/` });
      });
      return;
    }
    switch (url.pathname) {
      case '/login':
        return send(
          html(
            `<form id="f" method="post" action="/login">
               <input name="user"><input name="pass" type="password"><button id="go" type="submit">Sign in</button>
             </form>`,
            'Login'
          )
        );
      case '/home': {
        const cookie = /(?:^|;\s*)user=([^;]*)/.exec(req.headers.cookie ?? '')?.[1];
        return send(html(`<h1 id="who">Welcome ${cookie ? decodeURIComponent(cookie) : 'nobody'}</h1>`, 'Home'));
      }
      case '/blank-link':
        return send(html('<a id="l" target="_blank" href="/target">open</a>', 'Opener'));
      case '/target':
        return send(html('<h1>target page</h1>', 'Target'));
      case '/popup-opener':
        return send(
          html(
            `<button id="open" onclick="window.open('/popup','p','width=500,height=400')">open</button>
             <div id="msg"></div>
             <script>addEventListener('message', (e) => { if (e.origin === location.origin) msg.textContent = 'got:' + e.data; });</script>`,
            'Popup opener'
          )
        );
      case '/popup':
        return send(
          html(
            `<script>window.opener.postMessage('hello-from-popup', location.origin); window.close();</script>`,
            'Popup'
          )
        );
      case '/download-page':
        return send(
          html(
            `<a id="dl" href="/file?name=${encodeURIComponent(url.searchParams.get('name') ?? '')}">download</a>`,
            'Downloads'
          )
        );
      case '/file':
        return send('file contents', 200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${url.searchParams.get('name') ?? 'download.txt'}"`,
        });
      case '/geo':
        return send(
          html(
            `<button id="ask" onclick="navigator.geolocation.getCurrentPosition(
               (p) => { out.textContent = 'ok'; },
               (e) => { out.textContent = 'error:' + e.code + ':' + (e.code === e.PERMISSION_DENIED ? 'PERMISSION_DENIED' : 'other'); })">ask</button>
             <div id="out">pending</div>`,
            'Geo'
          )
        );
      case '/click':
        return send(
          html(
            `<button id="b" style="position:fixed;inset:0;width:100%;height:100%" onclick="out.textContent='clicked'">click</button>
             <div id="out">waiting</div>`,
            'Click'
          )
        );
      case '/counter':
        reloads += 1;
        return send(html(`<div id="n">${reloads}</div>`, 'Counter'));
      default:
        return send('not found', 404);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    lastLoginPost: () => loginPost,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Guest webviews and popups: every Electron page that is not the AionUi window itself. */
const guestPages = (electronApp: ElectronApplication, main: Page): Page[] =>
  electronApp.windows().filter((win) => win !== main && /^https?:|^about:blank/.test(win.url()));

/** Opens a browser tab at `url` through the same event target=_blank uses; resolves to its guest page. */
async function openBrowserTab(electronApp: ElectronApplication, main: Page, url: string): Promise<Page> {
  const known = new Set(guestPages(electronApp, main));
  await electronApp.evaluate(
    ({ BrowserWindow }, { key, name, target }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().startsWith('devtools://'));
      win?.webContents.send(key, JSON.stringify({ name, data: { url: target, background: false } }));
    },
    { key: BRIDGE_EVENT_KEY, name: OPEN_TAB_EVENT, target: url }
  );
  const findFresh = () => guestPages(electronApp, main).find((win) => !known.has(win) && win.url().startsWith(url));
  await expect.poll(findFresh, { message: `a browser tab for ${url}`, timeout: 20_000 }).toBeTruthy();
  const fresh = findFresh() as Page;
  await fresh.waitForLoadState('domcontentloaded');
  return fresh;
}

type ConversationRequest = { assistantId: string };

/** Creates a conversation (never messaged) so the preview panel can render, and opens it. */
async function createAndOpenConversation(main: Page, { assistantId }: ConversationRequest): Promise<string> {
  const id = await main.evaluate(async (assistant) => {
    const port = (window as unknown as { __backendPort?: number }).__backendPort;
    const response = await fetch(`http://127.0.0.1:${port}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'E2E built-in browser',
        assistant: { id: assistant },
        extra: { workspace: '/tmp', custom_workspace: true, session_mode: 'default' },
      }),
    });
    if (!response.ok) throw new Error(`POST /api/conversations failed (${response.status})`);
    return ((await response.json()) as { data: { id: string } }).data.id;
  }, assistantId);
  await main.goto(`${main.url().split('#')[0]}#/conversation/${id}`);
  // The sender textarea means the conversation page (and the preview provider's listeners) are mounted.
  await main.locator('textarea').first().waitFor({ state: 'visible', timeout: 30_000 });
  return id;
}

async function deleteConversation(main: Page, id: string): Promise<void> {
  await main
    .evaluate(async (conversationId) => {
      const port = (window as unknown as { __backendPort?: number }).__backendPort;
      await fetch(`http://127.0.0.1:${port}/api/conversations/${encodeURIComponent(conversationId)}`, {
        method: 'DELETE',
      });
    }, id)
    .catch(() => undefined);
}

/**
 * Presses `MOD+key` on the webview whose current url is `guestUrl`.
 * Playwright's own keyboard (CDP) hands keys straight to the renderer and skips the browser-side
 * `before-input-event` where the app handles shortcuts, so this uses `webContents.sendInputEvent`,
 * which takes the path a real keystroke takes.
 */
async function pressShortcut(electronApp: ElectronApplication, guestUrl: string, key: string): Promise<void> {
  const delivered = await electronApp.evaluate(
    ({ webContents }, { url, shortcutKey, modifier }) => {
      const target = webContents.getAllWebContents().find((wc) => wc.getType() === 'webview' && wc.getURL() === url);
      if (!target) return false;
      for (const type of ['rawKeyDown', 'keyUp'] as const) {
        target.sendInputEvent({ type, keyCode: shortcutKey, modifiers: [modifier] });
      }
      return true;
    },
    { url: guestUrl, shortcutKey: key, modifier: MOD }
  );
  expect(delivered, `no webview at ${guestUrl}`).toBe(true);
}

const waitForFile = async (file: string): Promise<void> => {
  await expect.poll(() => fs.existsSync(file) && fs.statSync(file).size > 0, { timeout: 15_000 }).toBe(true);
};

const NO_ASSISTANT_REASON =
  'Needs an installed Claude assistant: the browser panel only renders inside a conversation, which needs one';

test.describe('Built-in browser behaves like a regular browser', () => {
  let fixture: Fixture;
  let conversationId = '';

  test.beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  test.afterAll(async () => {
    await fixture.close();
  });

  test.beforeEach(async ({ page }) => {
    // The panel only renders in a conversation; create one per run and reuse it.
    if (conversationId) return;
    await goToGuid(page);
    const assistantId = await findAssistantIdForBackend(page, 'claude');
    // Never a silent skip: CI fails outright, and a local run reports each test as fixme with the reason.
    if (!assistantId && process.env.CI) throw new Error(NO_ASSISTANT_REASON);
    test.fixme(!assistantId, NO_ASSISTANT_REASON);
    conversationId = await createAndOpenConversation(page, { assistantId: assistantId ?? '' });
  });

  test.afterEach(async ({ electronApp, page }) => {
    // Close every tab with the browser's own Cmd/Ctrl+W so tabs do not pile up across tests. Addressed by
    // webContents, not url: other chats' tabs stay mounted in the background, and several may be about:blank.
    // One at a time and focused first, like a user: a key sent while another guest holds focus lands there.
    await electronApp.evaluate(async ({ webContents }, modifier) => {
      for (const tab of webContents.getAllWebContents().filter((wc) => wc.getType() === 'webview')) {
        tab.focus();
        for (const type of ['rawKeyDown', 'keyUp'] as const) {
          tab.sendInputEvent({ type, keyCode: 'w', modifiers: [modifier] });
        }
        for (let waited = 0; !tab.isDestroyed() && waited < 2000; waited += 50) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }, MOD);
    await expect.poll(() => page.locator('webview').count(), { timeout: 10_000 }).toBe(0);
  });

  test.afterAll(async ({ page }) => {
    if (conversationId) await deleteConversation(page, conversationId);
  });

  test('a real mouse click on the page reaches it (nothing covers the webview)', async ({ electronApp, page }) => {
    const guest = await openBrowserTab(electronApp, page, `${fixture.origin}/click`);
    // The active tab's webview: the pane may also hold its default blank tab, which is hidden.
    const box = await page.locator('webview:visible').boundingBox();
    expect(box, 'the webview has no on-screen box').not.toBeNull();
    const { x, y, width, height } = box as NonNullable<typeof box>;

    // Mouse input in the AionUi window, at the webview's centre: exactly what a user's click does.
    await page.mouse.click(x + width / 2, y + height / 2);

    await expect(guest.locator('#out')).toHaveText('clicked');
  });

  test('a login form POSTs its body and lands on the logged-in page', async ({ electronApp, page }) => {
    const guest = await openBrowserTab(electronApp, page, `${fixture.origin}/login`);

    // Typed, not `fill()`: fill() leaves the fields empty inside a <webview>.
    await guest.click('input[name=user]');
    await guest.keyboard.type('alice');
    await guest.keyboard.press('Tab');
    await guest.keyboard.type('s3cret');
    await guest.click('#go');

    await expect(guest.locator('#who')).toHaveText('Welcome alice');
    expect(guest.url()).toBe(`${fixture.origin}/home`);
    const post = fixture.lastLoginPost();
    expect(post?.contentType).toContain('application/x-www-form-urlencoded');
    expect(post?.body).toBe('user=alice&pass=s3cret');
  });

  test('a target=_blank link opens a second browser tab with that url', async ({ electronApp, page }) => {
    const opener = await openBrowserTab(electronApp, page, `${fixture.origin}/blank-link`);
    await expect(page.locator('webview')).toHaveCount(1);

    await opener.click('#l');

    await expect(page.locator('webview')).toHaveCount(2);
    await expect
      .poll(() => guestPages(electronApp, page).map((win) => win.url()))
      .toContain(`${fixture.origin}/target`);
    expect(opener.url()).toBe(`${fixture.origin}/blank-link`);
  });

  test('window.open with width/height opens a popup whose window.opener receives postMessage, then closes', async ({
    electronApp,
    page,
  }) => {
    const opener = await openBrowserTab(electronApp, page, `${fixture.origin}/popup-opener`);
    const popupOpened = electronApp.waitForEvent('window', { timeout: 15_000 });

    await opener.click('#open');
    const popup = await popupOpened;

    // The popup posts to window.opener and closes itself, so it only counts if both happen.
    await expect(opener.locator('#msg')).toHaveText('got:hello-from-popup');
    await expect.poll(() => popup.isClosed(), { timeout: 15_000 }).toBe(true);
    // A popup is a window, not a tab: the preview panel still has just the opener.
    await expect(page.locator('webview')).toHaveCount(1);
  });

  test('a download link saves the file into the downloads dir; a second one saves "name (1).ext"', async ({
    electronApp,
    page,
  }) => {
    // Unique per run and per retry, so "name (1).ext" is always the second download of this test.
    const downloadName = `e2e-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
    const guest = await openBrowserTab(
      electronApp,
      page,
      `${fixture.origin}/download-page?name=${encodeURIComponent(downloadName)}`
    );
    const { name, ext } = path.parse(downloadName);

    await guest.click('#dl');
    await waitForFile(path.join(e2eBrowserDownloadsDir, downloadName));
    await guest.click('#dl');
    await waitForFile(path.join(e2eBrowserDownloadsDir, `${name} (1)${ext}`));

    expect(fs.readFileSync(path.join(e2eBrowserDownloadsDir, downloadName), 'utf8')).toBe('file contents');
    expect(fs.readFileSync(path.join(e2eBrowserDownloadsDir, `${name} (1)${ext}`), 'utf8')).toBe('file contents');
  });

  test('geolocation request shows the permission prompt; Block denies it', async ({ electronApp, page }) => {
    const guest = await openBrowserTab(electronApp, page, `${fixture.origin}/geo`);

    await guest.click('#ask');

    const prompt = page.locator('.arco-modal').filter({ hasText: fixture.origin });
    await expect(prompt).toBeVisible();
    // Do not remember the answer: the store lives in the real ~/.aionui, which a test must not write.
    const remember = prompt.locator('.arco-checkbox input');
    await expect(remember).toBeChecked();
    await prompt.locator('.arco-checkbox').click();
    await expect(remember).not.toBeChecked();
    // Block is the default-styled button; Allow is the primary one.
    await prompt.locator('.arco-btn-secondary').click();

    await expect(guest.locator('#out')).toHaveText('error:1:PERMISSION_DENIED');
    await expect(prompt).toBeHidden();
  });

  test('Cmd/Ctrl+R in the page reloads the guest page', async ({ electronApp, page }) => {
    const guest = await openBrowserTab(electronApp, page, `${fixture.origin}/counter`);
    await expect(guest.locator('#n')).toHaveText('1');
    // A reload of the AionUi window would drop this; a reload of only the page cannot touch it.
    await page.evaluate(() => {
      (window as unknown as { __e2eMarker?: string }).__e2eMarker = 'alive';
    });
    const mainUrl = page.url();

    await pressShortcut(electronApp, guest.url(), 'r');

    await expect(guest.locator('#n')).toHaveText('2');
    expect(await page.evaluate(() => (window as unknown as { __e2eMarker?: string }).__e2eMarker)).toBe('alive');
    expect(page.url()).toBe(mainUrl);
  });
});
