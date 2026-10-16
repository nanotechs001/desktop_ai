/**
 * E2E: Changes tab of the project panel — real user flow on a single chat.
 *
 * Seeds a git repository as the chat's workspace (mocked native folder dialog), creates the
 * conversation from the guid page like workspace-single-chat.e2e.ts, writes a new file to disk,
 * then drives the Changes tab:
 *   1. Click the Changes tab
 *   2. Verify the new file is listed under the unstaged group
 *   3. Click Stage all → verify the file moves to the staged group
 *
 * Teams are removed from this fork, so this no longer goes through a team (Task 7).
 * The staging pipeline itself is covered by the integration suite; this file only asserts the
 * rendered UI state.
 *
 * Entry: `startWorkspaceChat` (guid page → claude assistant → `workspace-selector-btn` → `guid-input` → send, with the
 * claude command stubbed so no model runs), then `openProjectPanel` for the Files/Changes tabs.
 * Ran green on a fresh profile (AIONUI_MULTI_INSTANCE=1, throwaway AIONUI_E2E_USER_DATA_DIR).
 */
import { test, expect } from '../../fixtures';
import { openProjectPanel, startWorkspaceChat, type WorkspaceChat } from '../../helpers';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const GIT_IDENTITY = ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com'];

test.describe('Workspace Changes — single chat', () => {
  let workspace: string;

  test.beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-e2e-ws-snap-'));
    fs.writeFileSync(path.join(workspace, 'baseline.txt'), 'original');
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    execFileSync('git', [...GIT_IDENTITY, 'add', '.'], { cwd: workspace });
    execFileSync('git', [...GIT_IDENTITY, 'commit', '-q', '-m', 'baseline'], { cwd: workspace });
  });

  test.afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  let chat: WorkspaceChat | null = null;

  test.afterEach(async () => {
    await chat?.cleanup();
    chat = null;
  });

  test('changes tab lists a newly written file and Stage all moves it to staged', async ({ page, electronApp }) => {
    test.setTimeout(180_000);

    // Real entry path: guid page → choose the folder → type → send (claude is a stub, see startWorkspaceChat).
    chat = await startWorkspaceChat(page, electronApp, workspace, 'show me the changes in this project');
    if (!chat) {
      test.skip(true, 'Needs an installed claude agent to start a chat');
      return;
    }

    // ── Open the project panel's Changes tab ─────────────────────────────
    await openProjectPanel(page);
    const changesTab = page.getByRole('button', { name: /^(Changes|变更)$/ }).first();
    await expect(changesTab).toBeVisible({ timeout: 10_000 });

    // ── Seed a diff on disk, then show it ────────────────────────────────
    fs.writeFileSync(path.join(workspace, 'created.txt'), 'hello-snapshot');

    await changesTab.click();
    const scm = page.locator('[data-scm-panel]');
    await expect(scm).toBeVisible({ timeout: 15_000 });

    // The watcher usually reports the new file on its own; Refresh makes it deterministic.
    const refresh = page.getByRole('button', { name: /Refresh changes|刷新变更/ }).first();
    if (await refresh.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await refresh.click();
    }
    await page.screenshot({ path: 'tests/e2e/results/workspace-snapshot-01-changes-tab.png' });

    // ── New file is listed as an unstaged change ─────────────────────────
    const unstaged = scm.locator('[data-scm-group="unstaged"]');
    await expect(unstaged.getByText('created.txt').first()).toBeVisible({ timeout: 30_000 });
    await expect(scm.locator('[data-scm-group="staged"]')).toHaveCount(0);
    await page.screenshot({ path: 'tests/e2e/results/workspace-snapshot-02-unstaged.png' });

    // ── Stage all moves it to the staged group ───────────────────────────
    await scm.locator('[data-scm-header-stage-all]').click();

    const staged = scm.locator('[data-scm-group="staged"]');
    await expect(staged.getByText('created.txt').first()).toBeVisible({ timeout: 15_000 });
    await expect(scm.locator('[data-scm-group="unstaged"]').getByText('created.txt')).toHaveCount(0);
    await page.screenshot({ path: 'tests/e2e/results/workspace-snapshot-03-staged.png' });
  });
});
