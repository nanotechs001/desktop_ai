# Pixebot Browser — handover

_Last updated: 2026-10-18._

Pixebot Browser is a rebrand of the AionUi desktop app (Electron + React), with its own backend (AionCore, Rust) now living inside this repo under `core/`.

## Where things are

|          |                                                                                 |
| -------- | ------------------------------------------------------------------------------- |
| Repo     | https://github.com/nanotechs001/desktop_ai                                      |
| Backend  | `core/` (squashed git subtree of AionCore v0.2.2 + our "Always allow" fix)      |
| Dev data | `%APPDATA%\AionUi-Dev\` (database backup: `aionui\backup-before-lf-checksums\`) |

**Status check (2026-10-18):** the update paths no longer touch upstream (both read `nanotechs001/desktop_ai` releases); the remaining upstream-disconnect items are under Next.

## Run it

```bash
bun install
bun run core:build   # release build of core/ (loads the MSVC environment on Windows); ~5 min first time
bun run start        # uses core/target/release/aioncore automatically
```

Checks: `bunx tsc --noEmit`, `bun run lint` (0 errors expected; ~985 warnings are pre-existing), `bun run test`, `node scripts/check-i18n.js`.

## Done

**Branding**

- All user-facing text, titles, tray, installer name (`Pixebot Browser`, executable `PixebotBrowser`) rebranded in 13 languages. Internal names kept on purpose: `aioncore`, `AIONUI_*` env vars, `@aionui` packages, dev data folder `AionUi-Dev`. The installed app uses `com.nanotechs.pixebot` and `%APPDATA%\Pixebot Browser` (see Decisions).
- Logo: the transparent robot (`assets/branding/logo-mark.webp`) is the app icon, tray/notification icon, PWA icons and in-app logo. Rebuild with `node tools/build-app-icons.cjs`, which also writes macOS `resources/app.icns` (PNG-encoded entries, no Mac needed; 2026-10-18) and the mobile icons.

**macOS build (status 2026-10-18: not built yet)**

- Icon and identity are rebranded (`app.icns`, `productName`, `appId com.nanotechs.pixebot`); data lands in `~/Library/Application Support/Pixebot Browser`.
- Needs a Mac (or a macOS CI runner): `scripts/prepareLocalCore.js` builds `core/` for the host only, so run `bun run build-mac:arm64` / `build-mac:x64` on that architecture (or `AIONUI_BACKEND_SOURCE=release`, which bundles the stock backend without our fixes).
- Signing/notarization: `electron-builder.yml` `mac` uses hardened runtime + `entitlements.plist`; `scripts/afterSign.js` notarizes only when `appleId` / `appleIdPassword` (and a Developer ID certificate via `CSC_LINK`/keychain) are set — otherwise the app is unsigned and Gatekeeper blocks it on other Macs.
- Never run on macOS: the robot widget (always-on-top level `floating`, click-through), browser panel and updater (`latest-mac.yml` in GitHub releases) need a check on a real Mac.
- `.github/workflows/build-and-release.yml` and `_build-reusable.yml` don't use `prepareLocalCore` and need adapting before CI can produce Mac builds. The upstream-only workflows (project automation, issue triage, GPT review, web-cli packing, release distribution) are removed.

**Mobile app (`mobile/`, Expo) — rebranded 2026-10-18, not built yet**

- Name "Pixebot", slug `pixebot-mobile`, scheme `pixebot`, bundle id / package `com.nanotechs.pixebot.mobile`, new icon (`icon.png`, opaque navy for iOS) + Android adaptive foreground (`adaptive-icon.png`, bg `#0E1630`), QR-login hints point at "Pixebot Browser → Settings → Remote → QR Code Login" in all 5 locales. Storage keys (`aionui_connection`, `aionui_language`) kept so saved logins survive.
- Upstream's Expo project id (`extra.eas.projectId`) and the upstream author's Apple ID / team were removed from `app.config.ts`, `eas.json` and `scripts/build.js`. Before building: create an Expo account/project and run `eas init` in `mobile/`; set `EXPO_APPLE_ID`, `EXPO_APPLE_TEAM_ID` (and `APPLE_ID` for direct TestFlight upload); iOS builds need an Apple Developer account and a Mac (or EAS cloud build).
- What it is: a remote client for the desktop app's Remote (WebUI) server, paired by QR code; it has no VA Bot robots.
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
- (2026-10-18, uncommitted) No status label under the robot; its VA Bot name (`conversation.assistant.name`, else the chat title) fades in on hover/keyboard focus (`.marker` in `AgentWidget.module.css`).
- (2026-10-18, uncommitted) Smooth drag path: the robot now moves on each renderer pointer move (`agentWidget.dragMove`, once per frame) instead of only a 16 ms main-process timer (Windows timers fire at ~15.6 ms granularity, so the path stepped unevenly). The timer remains as a fallback when pointer moves go quiet for 50 ms; the 8 s watchdog counts from the last move; `restoreAfterDpiChange` ignores 1px DIP rounding so a step never moves the window twice.
- (2026-10-18) Popup history: the row "..." menu (archive, pin, rename…), dialogs and toasts render into `<body>`, outside `[data-widget-hit]`, so the click-through logic let clicks fall to the desktop. `WIDGET_HIT_SELECTOR` in `pages/agentWidget/index.tsx` now also counts `.arco-trigger`, `.arco-modal-wrapper`, `.arco-message-wrapper`. Archiving/deleting the robot's current chat from its own popup now removes the robot (the main window's listener never hears the widget window's events). Not yet checked: whether the main window's sidebar refreshes after an archive done in the widget (the backend sends no `listChanged` for archives).

**Settings pages (2026-10-18, uncommitted)**

- VA Bots page: the default chat agent (stored as a `source: 'user'` Agent) is no longer listed or counted under "My VA Bots" (`groupMyAssistants(assistants, storedDefaultId)` + `isVaBotAgent` in `AssistantHomeTabs`). It still counts under "Enabled".
- Engine page (`AgentSettings/LocalAgents.tsx`): no "All" tab (default tab is "Available"); the built-in CLI (`isBuiltinAionCli`: `agent_type 'aionrs'`, `agent_source 'internal'`) is not listed. It is still the default engine everywhere else, but there is no longer a UI to set it back as default after picking another engine.
- About page: title from `APP_PRODUCT_NAME`; GitHub icon, Help (`#readme`), Update Log (`/releases`) and Contact (`/issues`) point at `APP_REPO_URL` (`common/config/constants.ts`); "Official Website" removed (no site yet). The update check reads the same repo's releases (see Next).

**Official agents (VA Bots "Official" tab)**

- Defined only in this repo and compiled into the backend: `core/crates/aionui-app/assets/builtin-assistants/` (`assistants.json`, `rules/<id>.<locale>.md`, `avatars/<id>.jpg`) and `core/crates/aionui-app/assets/builtin-skills/` (embedded via `include_dir!` in `aionui-assistant/src/builtin.rs` and `aionui-extension/src/skill_service.rs`). Nothing fetches them at runtime. Edit them there and rebuild `core/`.
- They come from upstream only if the backend does: `AIONUI_BACKEND_SOURCE=release` builds bundle the stock AionCore with upstream's agents. A `git subtree pull` into `core/` can overwrite local edits to these files.
- (2026-10-18) Rebranded: every user-facing "AionUi" in `assistants.json` (all locales, e.g. "Pixebot Browser Butler"), the rule files (en-US, ru-RU, zh-CN) and the `builtin-skills` texts now says "Pixebot Browser". Identifiers are unchanged: agent ids (`aionui-assistant`), skill names (`aionui-config`, `aionui-troubleshooting`, `aionui-webui-*`), `aioncore`, `AIONUI_*`, `@aionui/webui`, file names. Kept on purpose: the Moltbook agent's `AionUi-` name prefix and "Powered by @aionui" line (a handle on a third-party site), the upstream wiki links in `aionui-webui-setup`, and paths/commands that name real AionUi files (`/Applications/AionUi.app`, `%APPDATA%/AionUi/webui.config.json`, `ps aux | grep AionUi`, sample `log_dir`, the font paths in `xiaohongshu-recruiter/scripts/generate_images.js`); check those against a real Pixebot install. The WebUI probe in `aionui-webui-public` accepts either `<title>`. Some texts still say Settings is "bottom left", which no longer matches the titlebar layout. Auto-inject skill descriptions must stay ≤ 200 chars (test in `aionui-extension/src/skill_service.rs`). `cargo test -p aionui-assistant` passes; `-p aionui-extension` passes except 5 Unix-only tests (`lifecycle::tests::test_execute_hook_*`, `import_skills_replaces_dangling_link_with_copy`) that fail on Windows regardless. **Not yet in the release binary:** `bun run core:build` was skipped (dev app kept running), so `core/target/release/aioncore.exe` still carries the old texts until the next `core:build` (close the dev app first).

**Backend**

- "Always allow" permission bug fixed in `core/crates/aionui-session/src/backend/claude_conn.rs` (returns `updatedPermissions`).
- VA Bots are instructed to save lessons after finished tasks (agent rules; no automatic learning beyond that).
- App prefers `core/target/release/aioncore` over the downloaded backend (`packages/desktop/src/process/backend/binaryResolver.ts`).

## In progress: local installer with our own backend

Goal: `bun run build-win:x64` produces a Pixebot Browser installer that bundles the backend built from `core/` (no download of the stock AionCore release).

Plan:

1. ✅ `scripts/prepareLocalCore.js` (uncommitted): runs `scripts/buildCore.js`, copies `core/target/release/aioncore(.exe)` to `resources/bundled-aioncore/<platform>-<arch>/`, runs `aioncore prepare-managed-resources` into `managed-resources/`, writes `manifest.json` (`sourceType: "local-core"`, version from `core/Cargo.toml`) and runs the bundle verifier. Host platform/arch only; any other target fails with a clear message. Run alone: `node scripts/prepareLocalCore.js`. Test: `tests/unit/assets/prepareLocalCore.test.ts`.
2. ✅ `scripts/build-with-builder.js` step 5 now calls `prepareLocalCore(...)`. Set `AIONUI_BACKEND_SOURCE=release` to get the old behaviour (stock download from `iOfficeAI/AionCore`, needed for cross-arch builds). `prepareManagedResources` is now exported from `packages/shared-scripts/src/prepare-aioncore.js`; the build test mock covers the new module.
   - **Verified 2026-10-18:** `node scripts/prepareLocalCore.js` succeeded. `resources/bundled-aioncore/win32-x64/` now has `sourceType: "local-core"`, `version: "v0.2.2"`, an `aioncore.exe` byte-identical to `core/target/release/aioncore.exe` (contains the `updatedPermissions` fix), `managed-resources/` with Node v24.11.0 (196 MB in total), and it passes the bundle verifier. The bundled binary starts (`--help`).
   - **Gotcha:** close the dev app (`bun run start`) first. Windows locks `core/target/release/aioncore.exe` while it runs, and cargo then fails with "Access is denied (os error 5)".
   - **Installer built 2026-10-18** with `bun run build-win:x64:fast` (~8 min): `out/Pixebot Browser-2.2.2-win-x64.exe` (246 MB, unsigned test build). `out/win-unpacked/resources/bundled-aioncore/win32-x64/` holds `sourceType: "local-core"` and an `aioncore.exe` byte-identical to the `core/` build. The installer version is still `2.2.2`, inherited from AionUi's `package.json`.
3. Build: `bun run build-win:x64` (or `build-win:x64:fast` for an unsigned, low-compression test build). Output in `out/`.
4. Install it and check: app starts, backend healthy, robots appear, "Always allow" sticks.

## Next: disconnect from upstream Aion

Functional (do first; these would talk to upstream):

- [x] Auto-updater (done 2026-10-18): both update paths read `nanotechs001/desktop_ai` GitHub releases (`APP_GITHUB_REPO`); nothing requests `static.aionui.com` or `iOfficeAI/AionUi` any more.
  - Automatic (electron-updater): `process/services/updateFeed.ts` → `GitHubReleaseProvider` (`process/services/githubReleaseProvider.ts`, a `GenericProvider` subclass). Channel file from `releases/latest/download/{latest.yml|latest-mac.yml|latest-arm64-mac.yml|latest-win-arm64.yml|latest-linux*.yml}`, files from `releases/download/v{version}/{file}`. Chosen over electron-updater's built-in `github` provider because it needs no API/atom lookup and keeps the per-arch channel names, which the built-in provider misreads as prerelease tags. A missing channel file (`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`: no release yet, or none for this platform) counts as "no update" and is not broadcast as an error.
  - Manual "Check for updates" (`process/bridge/updateBridge.ts`): stable reads the same `latest/download` channel file (a 404 means "up to date"), then attaches notes from the GitHub API on a best-effort basis. With **Include prerelease** on, it lists releases via the API, takes the highest semver non-draft tag (prereleases included) and reads that tag's channel file. If the API fails, it falls back to the stable lookup. Download links are `releases/download/{tag}/{file}` with no CDN fallback; the download allowlist is GitHub hosts only.
  - Not verified against a real release yet (the repo has none). For the first release: publish with electron-builder (`publish:` now targets this repo) so the `latest*.yml` files are uploaded. The tag must be `v{version}` and the version must be above the installed `2.2.2`. Check that each `latest*.yml` `url` matches the uploaded asset name (`artifactName` contains the space in "Pixebot Browser"). A prerelease must be marked as a prerelease on GitHub, or `latest/download` will serve it to stable users.
  - Tests: `tests/unit/updateBridgeRelease{Check,Manifest,Assets}.test.ts`, `updateBridgeDownloadDedupe.test.ts`, `tests/unit/process/services/{autoUpdaterService,updateFeed}.test.ts`.
- [x] `packages/desktop/electron-builder.yml` `publish` → `nanotechs001/desktop_ai` (produces `resources/app-update.yml`; the runtime feed is set in code).
- [x] `useUpdateNotificationController.ts` releases URL → `${APP_REPO_URL}/releases`.
- [ ] Backend download (`packages/shared-scripts/src/prepare-aioncore.js`, `scripts/prepareAioncore.js`) — replaced by the step above; keep only as an optional fallback or remove.
- [x] Model API attribution headers (done 2026-10-18): `common/api/ClientFactory.ts` sends `HTTP-Referer: APP_REPO_URL` and `X-Title: APP_PRODUCT_NAME` (OpenRouter app attribution) instead of `aionui.com` / `AionUi`.
- [x] Hub extensions (removed 2026-10-19): the vendored AionHub zips (`resources/hub-vendor/`), `scripts/prepareHubResources.js`, the `hub/` extraResources entry and the `missingHubDir` startup diagnostic are gone; the hub UI had already been removed and nothing read the bundled `hub/` folder.
- [ ] Skills market (`core/crates/aionui-extension/src/constants.rs` `SKILLS_MARKET_PATH = https://github.com/AionUI/aionui-skills`): left as is. It is only an identifier: the home-page toggle stores it as a custom skill source, and skill scanning skips it because it is not a folder; nothing fetches it. Changing the string would leave the old entry orphaned for anyone who already turned it on (disable matches the new string only). If the toggle should go, hide `SkillsMarketBanner` instead.
- [ ] Backend version check (`core/crates/aionui-system/src/version.rs` `DEFAULT_REPO = iOfficeAI/AionUi`, used when a request names no repo). The desktop updater does not call it; change it in `core/` when convenient.

In-app links (repoint to the own repo, or hide when there is no equivalent):

- [x] About page (done 2026-10-18).
- [x] Rest (done 2026-10-18): home quick-action GitHub button → `APP_REPO_URL`; "download latest" in `InstallationIntegrityDialog` and the (discontinued-build only) `UpdateMigrationDialog` → `${APP_REPO_URL}/releases/latest`; DingTalk link (its text says "DingTalk Open Platform") → `https://open-dev.dingtalk.com/`. Former upstream wiki/discussion links (LLM config guide in the model settings empty state, image-generation help on the tools page, ACP setup guide on the agents page, skills-market "details") temporarily open `APP_DOCS_URL` (`${APP_REPO_URL}#readme`, in `common/config/constants.ts`) until the app has its own docs; give each a real page later. Still hidden: the "Open a PR on AionHub" hint in the agent hub modal (its text names AionHub and the listed agents come from the vendored upstream hub, so this repo has no equivalent; its i18n keys are unused).
- Keep: OfficeCLI links (`iOfficeAI/OfficeCLI` is a third-party tool the app uses).

Repo infrastructure:

- [x] Upstream repo infrastructure (removed 2026-10-19): upstream workflows and `.github` meta files (issue templates, CODEOWNERS, triage map, GPT review actions), `pr-checks.yml` / `_build-reusable.yml` repo guards and the discontinued-build flag, `homebrew/`, the web-cli package and its install/release-asset scripts, `Dockerfile`, `Makefile`, `.gemini/`, `.specify/`, `.claude/skills/bump-version/`, upstream PRDs/guides/e2e docs, README media. Release updater metadata (`latest*.yml`) is now assembled inline in `build-and-release.yml`.
- [x] Root `package.json` author → `nanotechs001` / `nanotechs001@users.noreply.github.com` (placeholder contact; electron-builder uses it as the Linux package maintainer and Windows company name — replace with a real address if wanted). `"name": "AionUi"` kept: Electron derives `app.getName()` from it (no `productName` in the root package.json), which feeds the dev data folder, single-instance lock and macOS safe-storage key, so renaming it could orphan existing data.
- Kept on purpose: `iOfficeAI/OfficeCli` links and installer URLs (third-party tool the Office agents need); `core/Cargo.toml` git dependency on `iOfficeAI/aionrs` (build-time source for the agent crates; vendor or fork it to cut that tie); `core/scripts/just/update-aionrs.*`; `copyright: Copyright © 2024 AionUi` and the Apache license headers (attribution required by the license); upstream issue numbers in code comments and test fixtures.

## Decisions needed

1. ✅ **Installer identity — decided 2026-10-18:** `appId: com.nanotechs.pixebot` (`electron-builder.yml`, `WINDOWS_APP_USER_MODEL_ID` in `process/startup/windowsAppUserModelId.ts`, dev updater `updaterCacheDirName`). It no longer replaces or upgrades a stock AionUi install.
2. ✅ **Production data folder — decided 2026-10-18:** `%APPDATA%\Pixebot Browser` (`PRODUCTION_DATA_DIR_NAME` in `process/utils/configureChromium.ts`). The installer failure marker follows it (`process/services/installerLastFailure.ts` and `resources/windows/installer-process-control.nsh`); keep all three in sync. Dev data stays in `%APPDATA%\AionUi-Dev`.
3. ✅ **Updates — decided 2026-10-18:** the updater reads `nanotechs001/desktop_ai` GitHub releases (see Next). Until there is a release it reports "up to date".

## Notes and gotchas

- **Line endings and the database.** Git here uses `core.autocrlf=true`; the repo enforces LF. The backend stores checksums of its SQL migrations, so a backend built from CRLF files cannot open a database migrated by an LF build (and vice versa). The dev database was corrected to LF checksums (backup noted above). Always build `core/` from this repo.
- **Upstream backend updates:** `git subtree pull --prefix=core https://github.com/iOfficeAI/AionCore main --squash`, then re-check `claude_conn.rs` (the Always-allow fix).
- **Pre-existing test failures** (fail on a clean checkout too, unrelated to this work): imageGenCore, artifacts/store, e2eDataIsolation, claudeLauncher, browserSession, downloads, profiles, plus flaky relayServer and mermaid.
- **Dev hot reload** reloads robot windows; they now replay `appearing` instead of freezing.
- The agent CLI shown in chats is Claude Code; its own memory is separate from the app.
