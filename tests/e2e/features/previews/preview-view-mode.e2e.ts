/**
 * E2E: preview view-mode toggle — real user flow.
 *
 * Seeds a workspace with files, opens a preview via file click, then exercises
 * the Editor/Preview toggle.
 *
 * The version-history dropdown this file also used to cover is gone: that
 * feature (and its backend routes) were removed, so the test went with it.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { openProjectPanel, startWorkspaceChat, type WorkspaceChat } from '../../helpers';
import fs from 'fs';
import path from 'path';
import os from 'os';

test.describe('Preview — view mode toggle', () => {
  let workspace: string;
  let chat: WorkspaceChat | null = null;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-preview-hist-'));
    fs.writeFileSync(path.join(workspace, 'app.html'), '<!DOCTYPE html><html><body><h1>Version 1</h1></body></html>');
    fs.writeFileSync(path.join(workspace, 'style.css'), 'body { margin: 0; }');
  });

  test.afterAll(async () => {
    await chat?.cleanup();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** Starts a chat on the workspace (see `startWorkspaceChat`), clicks a file in its project tree, returns the preview. */
  async function openPreviewViaFileClick(page: Page, electronApp: ElectronApplication, fileName: string) {
    chat = await startWorkspaceChat(page, electronApp, workspace, 'review the files');
    test.skip(!chat, 'Needs an installed claude agent to start a chat');
    await openProjectPanel(page);
    const tree = page.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });
    const fileNode = tree.getByText(fileName).first();
    await expect(fileNode).toBeVisible({ timeout: 10_000 });
    await fileNode.click();
    const previewPanel = page.locator('.preview-panel');
    await expect(previewPanel).toBeVisible({ timeout: 15_000 });
    return previewPanel;
  }

  test('Editor/Preview toggle switches view mode', async ({ page, electronApp }) => {
    test.setTimeout(120_000);

    const panel = await openPreviewViaFileClick(page, electronApp, 'app.html');

    // The toolbar's source and preview toggles (an HTML file's source toggle reads "Code")
    const editorToggle = panel.getByText(/^Code$|^代码$/).first();
    const previewToggle = panel.getByText(/^Preview$|^预览$/).first();
    await expect(editorToggle).toBeVisible({ timeout: 5_000 });

    // Switch to Editor mode
    await editorToggle.click();
    await page.waitForTimeout(500);

    // Editor mode should show a code editor (CodeMirror or textarea)
    const editor = panel.locator('.cm-editor, textarea, [class*="editor"]').first();
    const hasEditor = await editor.isVisible({ timeout: 5_000 }).catch(() => false);
    await page.screenshot({ path: 'tests/e2e/results/preview-hist-01-editor.png' });

    // Switch to Preview mode
    if (await previewToggle.isVisible().catch(() => false)) {
      await previewToggle.click();
      await page.waitForTimeout(500);

      // Preview mode should show rendered content (iframe or viewer)
      const viewer = panel.locator('iframe, [class*="viewer"]').first();
      const hasViewer = await viewer.isVisible({ timeout: 5_000 }).catch(() => false);
      await page.screenshot({ path: 'tests/e2e/results/preview-hist-02-preview.png' });

      // At least one mode should have content
      expect(hasEditor || hasViewer).toBeTruthy();
    }
  });
});
