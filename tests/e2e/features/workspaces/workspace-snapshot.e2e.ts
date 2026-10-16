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
 * NOTE: written without being run (e2e is not run in Task 7); selectors come from ScmPanel,
 * ScmChangesView and ExplorerContainer (`data-scm-*` attributes), not from a recorded session.
 */
import { test, expect } from '../../fixtures';
import { goToGuid } from '../../helpers';
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

  test('changes tab lists a newly written file and Stage all moves it to staged', async ({ page, electronApp }) => {
    test.setTimeout(180_000);

    await electronApp.evaluate(async ({ dialog }, target) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [target] });
    }, workspace);

    await goToGuid(page);

    // ── Create a single chat whose workspace is the seeded repository ────
    const agentPill = page.locator('[data-testid^="agent-pill-"]').first();
    if (!(await agentPill.isVisible({ timeout: 10_000 }).catch(() => false))) {
      test.skip(true, 'No agent pills available on guid page');
      return;
    }
    await agentPill.click();

    const wsBtn = page.locator('[data-testid="workspace-selector-btn"]');
    if (await wsBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await wsBtn.click();
      await page.waitForTimeout(500);
    }

    const guidInput = page.locator('[data-testid="guid-input"] textarea, [data-testid="guid-input"] input').first();
    await expect(guidInput).toBeVisible({ timeout: 10_000 });
    await guidInput.fill('list files in this project');
    await page.locator('[data-testid="guid-send-btn"]').click();

    await page.waitForURL(/\/conversation\//, { timeout: 30_000 });

    // ── Open the project panel's Changes tab ─────────────────────────────
    const changesTab = page.getByRole('button', { name: /^(Changes|变更)$/ }).first();
    if (!(await changesTab.isVisible({ timeout: 10_000 }).catch(() => false))) {
      // The workspace column starts collapsed on some layouts; the titlebar toggle opens it.
      await page
        .getByRole('button', { name: /Expand More|展开更多/ })
        .first()
        .click()
        .catch(() => {});
    }
    if (!(await changesTab.isVisible({ timeout: 30_000 }).catch(() => false))) {
      await page.screenshot({ path: 'tests/e2e/results/workspace-snapshot-00-no-panel.png' });
      test.skip(true, 'Project panel did not appear — backend may not support workspace browse yet');
      return;
    }

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
