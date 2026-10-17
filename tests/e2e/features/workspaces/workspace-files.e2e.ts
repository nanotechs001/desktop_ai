/**
 * E2E: Workspace Files tab — real user flow.
 *
 * Starts a single chat on a seeded workspace from the guid page (see `startWorkspaceChat`; the claude command is a
 * stub, so no model session starts), opens the project panel and verifies the file tree, a nested folder and search.
 * The backend contract for `/api/fs/*` is covered separately in the Vitest integration suite (tests/integration).
 */
import { test, expect } from '../../fixtures';
import { openProjectPanel, startWorkspaceChat, type WorkspaceChat } from '../../helpers';
import fs from 'fs';
import path from 'path';
import os from 'os';

test.describe('Workspace Files — UI panel', () => {
  let workspace: string;
  let chat: WorkspaceChat | null = null;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-ws-files-'));
    fs.writeFileSync(path.join(workspace, 'readme.md'), '# seeded');
    fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'notes', 'alpha.txt'), 'alpha');
    fs.writeFileSync(path.join(workspace, 'notes', 'beta.txt'), 'beta');
  });

  test.afterAll(async () => {
    await chat?.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('workspace panel renders tree and search for a chat workspace', async ({ page, electronApp }) => {
    test.setTimeout(120_000);

    chat = await startWorkspaceChat(page, electronApp, workspace, 'what is in this folder?');
    if (!chat) {
      test.skip(true, 'Needs an installed claude agent to start a chat');
      return;
    }
    await openProjectPanel(page);

    const tree = page.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });
    await expect(tree.getByText('readme.md').first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: 'tests/e2e/results/workspace-files-01-tree.png' });

    // A nested folder opens to its files.
    await tree.getByText('notes', { exact: true }).first().click();
    await expect(tree.getByText('alpha.txt').first()).toBeVisible({ timeout: 5_000 });
    await expect(tree.getByText('beta.txt').first()).toBeVisible({ timeout: 5_000 });

    // Search accepts a query and finds a nested file.
    const searchInput = page.getByRole('textbox', { name: /Search|搜索/ }).first();
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await searchInput.fill('alpha');
    await expect(searchInput).toHaveValue('alpha');
    await expect(page.getByText('alpha.txt').first()).toBeVisible({ timeout: 10_000 });
    await searchInput.fill('');
    await page.screenshot({ path: 'tests/e2e/results/workspace-files-02-search.png' });
  });
});
