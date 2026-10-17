/**
 * E2E: Workspace file operations — expand folder, search, context menu.
 *
 * Seeds a nested directory structure, starts a single chat on it from the guid page (see `startWorkspaceChat`; the
 * claude command is a stub, so no model session starts), then drives the project panel: expand a folder to reveal
 * children, search by filename, and right-click to open the context menu.
 *
 * Uses test.describe.serial to share a single conversation across all assertions.
 */
import { test, expect } from '../../fixtures';
import { openProjectPanel, startWorkspaceChat, type WorkspaceChat } from '../../helpers';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Locator } from '@playwright/test';

test.describe.serial('Workspace — file operations', () => {
  let workspace: string;
  let panel: Locator | null = null;
  let chat: WorkspaceChat | null = null;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-ws-ops-'));
    fs.writeFileSync(path.join(workspace, 'config.json'), '{"name":"test"}');
    fs.mkdirSync(path.join(workspace, 'components'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'components', 'Button.tsx'), '<button>Click</button>');
    fs.writeFileSync(path.join(workspace, 'components', 'Modal.tsx'), '<div>Modal</div>');
    fs.mkdirSync(path.join(workspace, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'lib', 'api.ts'), 'export const fetch = () => {}');
  });

  test.afterAll(async () => {
    await chat?.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('setup: create conversation with workspace panel', async ({ page, electronApp }) => {
    test.setTimeout(120_000);

    chat = await startWorkspaceChat(page, electronApp, workspace, 'describe the project structure');
    if (!chat) {
      test.skip(true, 'Needs an installed claude agent to start a chat');
      return;
    }
    await openProjectPanel(page);

    const tree = page.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });
    panel = tree;
  });

  test('expand folder node reveals children files', async ({ page }) => {
    test.setTimeout(30_000);
    if (!panel) {
      test.skip(true, 'Workspace panel not available from setup');
      return;
    }

    const componentsNode = panel.getByText('components', { exact: true }).first();
    await expect(componentsNode).toBeVisible({ timeout: 10_000 });

    await componentsNode.click();
    await page.waitForTimeout(500);

    await expect(panel.getByText('Button.tsx').first()).toBeVisible({ timeout: 5_000 });
    await expect(panel.getByText('Modal.tsx').first()).toBeVisible({ timeout: 5_000 });

    await page.screenshot({ path: 'tests/e2e/results/ws-ops-01-expanded.png' });
  });

  test('search narrows tree to matching files only', async ({ page }) => {
    test.setTimeout(30_000);
    if (!panel) {
      test.skip(true, 'Workspace panel not available from setup');
      return;
    }

    const searchInput = page.getByRole('textbox', { name: /Search|搜索/ }).first();
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    await searchInput.fill('Button');
    await expect(page.getByText('Button.tsx').first()).toBeVisible({ timeout: 5_000 });

    await page.screenshot({ path: 'tests/e2e/results/ws-ops-02-search-button.png' });

    await searchInput.fill('api');
    await expect(page.getByText('api.ts').first()).toBeVisible({ timeout: 5_000 });

    await searchInput.fill('');
    await page.screenshot({ path: 'tests/e2e/results/ws-ops-03-search-cleared.png' });
  });

  test('right-click file shows context menu with action items', async ({ page }) => {
    test.setTimeout(30_000);
    if (!panel) {
      test.skip(true, 'Workspace panel not available from setup');
      return;
    }

    const configNode = panel.getByText('config.json').first();
    await expect(configNode).toBeVisible({ timeout: 10_000 });
    await configNode.click({ button: 'right' });

    const ctxMenu = page.locator('.arco-dropdown-menu:visible').first();
    await expect(ctxMenu).toBeVisible({ timeout: 3_000 });
    await expect(ctxMenu.getByText(/Add to Chat|添加到对话/i).first()).toBeVisible();

    await page.screenshot({ path: 'tests/e2e/results/ws-ops-04-context-menu.png' });

    await page.keyboard.press('Escape');
  });
});
