/**
 * E2E: Preview panel — file click triggers preview.
 *
 * Seeds a workspace with an HTML file and a Markdown file, starts a single chat on it from the guid page (see
 * `startWorkspaceChat`; the claude command is a stub, so no model session starts), then clicks the file in the project
 * panel's tree to trigger the preview panel. Verifies the preview renders content and the toolbar shows action buttons.
 *
 * This is deterministic — no dependency on agent output.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { openProjectPanel, startWorkspaceChat, type WorkspaceChat } from '../../helpers';
import fs from 'fs';
import path from 'path';
import os from 'os';

const HTML_CONTENT = `<!DOCTYPE html>
<html><head><title>E2E Preview</title></head>
<body><h1>Hello Preview</h1><p>This is a test page.</p></body>
</html>`;

const MD_CONTENT = `# Preview Test\n\nThis is **bold** and *italic*.\n\n- Item 1\n- Item 2\n`;

test.describe('Preview — file click triggers preview', () => {
  const workspaces: string[] = [];
  const chats: WorkspaceChat[] = [];

  test.afterAll(async () => {
    for (const chat of chats.toReversed()) {
      // eslint-disable-next-line no-await-in-loop -- each cleanup may restore the default engine through the UI
      await chat.cleanup();
    }
    for (const workspace of workspaces) fs.rmSync(workspace, { recursive: true, force: true });
  });

  /**
   * Starts a chat on a fresh workspace (its own project, so no preview from an earlier test takes the panel's room)
   * and clicks `fileName` in its project tree; returns the preview panel.
   */
  async function previewFile(page: Page, electronApp: ElectronApplication, fileName: string, message: string) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-preview-'));
    workspaces.push(workspace);
    fs.writeFileSync(path.join(workspace, 'page.html'), HTML_CONTENT);
    fs.writeFileSync(path.join(workspace, 'notes.md'), MD_CONTENT);
    fs.writeFileSync(path.join(workspace, 'data.json'), '{"key":"value","count":42}');
    const chat = await startWorkspaceChat(page, electronApp, workspace, message);
    test.skip(!chat, 'Needs an installed claude agent to start a chat');
    chats.push(chat as WorkspaceChat);
    await openProjectPanel(page);
    const tree = page.locator('.workspace-tree');
    await expect(tree).toBeVisible({ timeout: 15_000 });
    const file = tree.getByText(fileName).first();
    await expect(file).toBeVisible({ timeout: 10_000 });
    await file.click();
    const previewPanel = page.locator('.preview-panel');
    await expect(previewPanel).toBeVisible({ timeout: 15_000 });
    return previewPanel;
  }

  test('clicking HTML file in workspace tree opens preview panel', async ({ page, electronApp }) => {
    test.setTimeout(120_000);
    const previewPanel = await previewFile(page, electronApp, 'page.html', 'check the HTML file');
    await page.screenshot({ path: 'tests/e2e/results/preview-conv-01-clicked.png' });

    // Preview should have content (iframe for HTML, or viewer)
    const content = previewPanel.locator('iframe, [class*="viewer"], [class*="editor"], pre, .cm-editor').first();
    await expect(content).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: 'tests/e2e/results/preview-conv-02-preview.png' });

    // Toolbar should have action buttons
    const downloadBtn = previewPanel.locator('[title*="download"], [title*="Download"], [title*="下载"]').first();
    const openBtn = previewPanel.locator('[title*="open"], [title*="Open"], [title*="打开"]').first();
    expect(
      (await downloadBtn.isVisible().catch(() => false)) || (await openBtn.isVisible().catch(() => false))
    ).toBeTruthy();
  });

  test('clicking markdown file opens preview with rendered content', async ({ page, electronApp }) => {
    test.setTimeout(120_000);
    const previewPanel = await previewFile(page, electronApp, 'notes.md', 'read the notes');

    // The rendered markdown (or its source in the editor) shows the file's heading
    const viewer = previewPanel.locator('.aionui-markdown, .cm-editor').first();
    await expect(viewer).toBeVisible({ timeout: 10_000 });
    await expect(viewer).toContainText('Preview Test');

    await page.screenshot({ path: 'tests/e2e/results/preview-conv-03-markdown.png' });
  });
});
