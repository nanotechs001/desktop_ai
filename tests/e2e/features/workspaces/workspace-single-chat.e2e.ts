/**
 * E2E: Single-chat workspace panel — real user flow.
 *
 * Seeds a directory with known files, mocks the native folder dialog, then creates a conversation from
 * the guid page with that workspace (see `startWorkspaceChat`: assistant pill → `workspace-selector-btn`
 * → `guid-input` → send; the claude command is a stub so no model session starts). Verifies the project
 * panel renders the seeded files, search works, and the Files/Changes tabs switch correctly.
 */
import { test, expect } from '../../fixtures';
import { openProjectPanel, startWorkspaceChat, type WorkspaceChat } from '../../helpers';
import fs from 'fs';
import path from 'path';
import os from 'os';

test.describe('Workspace — single chat', () => {
  let workspace: string;
  let chat: WorkspaceChat | null = null;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-ws-single-'));
    fs.writeFileSync(path.join(workspace, 'readme.md'), '# My Project\n\nHello world.');
    fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'src', 'index.ts'), 'console.log("hello");');
    fs.writeFileSync(path.join(workspace, 'src', 'utils.ts'), 'export const add = (a: number, b: number) => a + b;');
  });

  test.afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test.afterEach(async () => {
    await chat?.cleanup();
    chat = null;
  });

  test('user selects workspace folder, sends message, sees files in panel', async ({ page, electronApp }) => {
    test.setTimeout(120_000);

    chat = await startWorkspaceChat(page, electronApp, workspace, 'list files in this project');
    if (!chat) {
      test.skip(true, 'Needs an installed claude agent to start a chat');
      return;
    }

    await openProjectPanel(page);
    const filesTab = page.getByRole('button', { name: /^(Files|文件)$/ }).first();
    await page.screenshot({ path: 'tests/e2e/results/ws-single-01-panel.png' });

    // File tree should show our seeded readme.md
    const tree = page.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });
    await expect(tree.getByText('readme.md').first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'tests/e2e/results/ws-single-02-tree.png' });

    // Search for "index" → should find src/index.ts
    const searchInput = page.getByRole('textbox', { name: /Search|搜索/ }).first();
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await searchInput.fill('index');
    await expect(page.getByText('index.ts').first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'tests/e2e/results/ws-single-03-search.png' });
    await searchInput.fill('');

    // Switch to the Changes tab and back
    const changesTab = page.getByRole('button', { name: /^(Changes|变更)$/ }).first();
    await expect(changesTab).toBeVisible({ timeout: 5_000 });
    await changesTab.click();
    await page.screenshot({ path: 'tests/e2e/results/ws-single-04-changes.png' });

    await filesTab.click();
    await expect(tree.getByText('readme.md').first()).toBeVisible({ timeout: 10_000 });
  });
});
