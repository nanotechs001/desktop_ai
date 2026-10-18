# Pixebot Browser — handover

_Last updated: 2026-10-18._

Pixebot Browser is a rebrand of the AionUi desktop app (Electron + React), with its own backend (AionCore, Rust) now living inside this repo under `core/`.

## Where things are

|                      |                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                 | https://github.com/nanotechs001/desktop_ai (local: `E:\AI_WORKER\desktop_ai`)                                                                  |
| Working branch       | `feat/pixebot-browser` — **nothing pushed yet**                                                                                                |
| Backend              | `core/` (squashed git subtree of AionCore v0.2.2 + our "Always allow" fix)                                                                     |
| Old backend checkout | `E:\AI_WORKER\AionCore` (fork `nanotechs001/AionCore`, branch `fix/claude-always-allow`). No longer needed; its 3 GB `target/` can be deleted. |
| Dev data             | `%APPDATA%\AionUi-Dev\` (database backup: `aionui\backup-before-lf-checksums\`)                                                                |

Commits on the branch (oldest first):

1. `5160386ec` feat: Pixebot Browser rebrand, VA Bots and floating desktop robots
2. `7ae079286` / `2e3c38dab` chore(core): add AionCore backend under `core/`
3. `94404d22d` build(core): run the app on the in-repo backend

## Run it

```bash
bun install
bun run core:build   # release build of core/ (loads the MSVC environment on Windows); ~5 min first time
bun run start        # uses core/target/release/aioncore automatically
```

Checks: `bunx tsc --noEmit`, `bun run lint` (0 errors expected; ~985 warnings are pre-existing), `bun run test`, `node scripts/check-i18n.js`.

## Done

**Branding**

- All user-facing text, titles, tray, installer name (`Pixebot Browser`, executable `PixebotBrowser`) rebranded in 13 languages. Internal names kept on purpose: `aioncore`, `AIONUI_*` env vars, `@aionui` packages, data folder `AionUi`.
- Logo: the transparent robot (`assets/branding/logo-mark.webp`) is the app icon, tray/notification icon, PWA icons and in-app logo. Rebuild with `node tools/build-app-icons.cjs`. macOS `app.icns` is **not** regenerated (needs a Mac).
- README rewritten for the new app.

**Layout and navigation**

- Left icon bar removed (kept only on Settings pages). Top-right titlebar nav: New chat, Chat history (regular chats only), VA Bots (halo-orb icon, `assets/branding/toolbar/halo-orb-toolbar.svg`, inlined in `TitlebarNav.tsx`), Scheduled, Settings.
- Regular chats: chat left, browser/preview + files right, temporary in-memory browser per chat (wiped when its tabs close).
- VA Bots (any user-created Agent): persistent browser profile, browser on top, collapsible bottom chat + files pane, per-bot chat history (chat header, bot card, robot popup).
- "Installed agent is newer than verified" chat notice hidden.

**Floating robot (one per VA Bot)**

- 30 FPS, manifest-driven sprite animations (`assets/ai-robot-concepts/animation-strips-v1/animation-30fps-manifest.json`; rebuild strips with `node tools/build-robot-sprites.cjs`). Idle keeps its slow 2.8 s resting loop.
- Appearing / disappearing, dragging and drop-landing (falls onto the taskbar at the impact frame), turn-to-user, mouse following, panic flip while waiting for a permission, hides while its chat is open in the main window.
- One robot per bot: a new session moves the existing robot; older per-conversation robots collapse to the newest on startup. Robot popup history (overlay with back button) switches the robot's conversation.
- Multi-monitor fix for mixed scaling (125% laptop + 100% monitor).
- Code: `packages/desktop/src/process/pet/agentWidget/` (window manager), `packages/desktop/src/renderer/pages/agentWidget/` (robot page, animation clock, popup). Tests: `tests/integration/agentWidget/` (113 passing).

**Backend**

- "Always allow" permission bug fixed in `core/crates/aionui-session/src/backend/claude_conn.rs` (returns `updatedPermissions`).
- VA Bots are instructed to save lessons after finished tasks (agent rules; no automatic learning beyond that).
- App prefers `core/target/release/aioncore` over the downloaded backend (`packages/desktop/src/process/backend/binaryResolver.ts`).

## In progress: local installer with our own backend

Goal: `bun run build-win:x64` produces a Pixebot Browser installer that bundles the backend built from `core/` (no download of the stock AionCore release).

Plan:

1. Add `scripts/prepareLocalCore.js`: run `scripts/buildCore.js`, copy `core/target/release/aioncore(.exe)` to `resources/bundled-aioncore/<platform>-<arch>/`, then run `aioncore prepare-managed-resources --bundle-out <that dir>/managed-resources` (produces the bundled Node runtime) and write `manifest.json` (`sourceType: "local-core"`). Host platform/arch only.
2. In `scripts/build-with-builder.js` step 5, replace `prepareAioncore(...)` (downloads from `iOfficeAI/AionCore`) with `prepareLocalCore(...)`.
3. Build: `bun run build-win:x64` (or `build-win:x64:fast` for an unsigned, low-compression test build). Output in `out/`.
4. Install it and check: app starts, backend healthy, robots appear, "Always allow" sticks.

## Next: disconnect from upstream Aion

Functional (do first; these would talk to upstream):

- [ ] Auto-updater: `packages/desktop/src/process/bridge/updateBridge.ts` `DEFAULT_REPO = 'iOfficeAI/AionUi'` → `nanotechs001/desktop_ai`, or disable updates until releases exist. Today the app could offer to "update" to stock AionUi.
- [ ] `packages/desktop/electron-builder.yml` `publish.owner/repo` (`iOfficeAI/AionUi`) → `nanotechs001/desktop_ai`.
- [ ] `useUpdateNotificationController.ts` releases URL → own releases page.
- [ ] Backend download (`packages/shared-scripts/src/prepare-aioncore.js`, `scripts/prepareAioncore.js`) — replaced by the step above; keep only as an optional fallback or remove.

In-app links (repoint to the own repo, or hide when there is no equivalent):

- [ ] About page (repo, wiki, releases), home quick-action GitHub link, LLM config and ACP setup wiki links, tools page wiki links, skills-market banner discussions, AionHub link, DingTalk docs link.
- Keep: OfficeCLI links (`iOfficeAI/OfficeCLI` is a third-party tool the app uses).

Repo infrastructure:

- [ ] `.github/ISSUE_TEMPLATE/config.yml`, `.github/workflows/project-automation.yml` and `issue-triage.yml` (upstream org/project specific), `homebrew/aionui.rb.example`, `scripts/install-ubuntu.sh`, `scripts/install-web.sh`, `.claude/skills/bump-version/SKILL.md`.

## Decisions needed

1. **Installer identity (`appId: com.aionui.app`).** Same id as stock AionUi, so installing one upgrades/replaces the other on Windows. Recommend a new id (e.g. `com.nanotechs.pixebot`).
2. **Production data folder (`%APPDATA%\AionUi`).** Kept earlier so chats would carry over, but it is shared with a stock AionUi install, and their backends can disagree on database migrations. Recommend `Pixebot Browser` unless existing installed-app data must carry over (none exists on this machine).
3. **Updates.** Point the updater at `nanotechs001/desktop_ai` releases, or turn it off until there is a release process.

## Notes and gotchas

- **Line endings and the database.** Git here uses `core.autocrlf=true`; the repo enforces LF. The backend stores checksums of its SQL migrations, so a backend built from CRLF files cannot open a database migrated by an LF build (and vice versa). The dev database was corrected to LF checksums (backup noted above). Always build `core/` from this repo.
- **Upstream backend updates:** `git subtree pull --prefix=core https://github.com/iOfficeAI/AionCore main --squash`, then re-check `claude_conn.rs` (the Always-allow fix).
- **Pre-existing test failures** (fail on a clean checkout too, unrelated to this work): imageGenCore, artifacts/store, e2eDataIsolation, claudeLauncher, browserSession, downloads, profiles, plus flaky relayServer and mermaid.
- **Dev hot reload** reloads robot windows; they now replay `appearing` instead of freezing.
- The agent CLI shown in chats is Claude Code; its own memory is separate from the app.
