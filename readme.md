# Pixebot Browser

A desktop AI workspace with a built-in browser. Chat with AI agents, let them browse and work for you, and keep your own **VA Bots** on the taskbar.

## Features

- **Regular chats** — chat on the left, browser/preview and files on the right. The agent's browser is temporary: each chat gets its own fresh, in-memory session (no saved logins by default; you can import cookies for the session). It is wiped when the chat's tabs close or the app restarts.
- **VA Bots** — Agents you create. Each has a persistent browser profile (logins survive restarts), a browser-first layout (browser on top, chat collapsed underneath with a chat toggle, files beside the chat), and its own robot on the taskbar.
- **Taskbar robots** — each VA Bot gets a small animated robot that sits on the taskbar edge. Click it to open that bot's chat in a popup; it turns to face you, shows what the bot is doing (thinking, browsing, working, talking, listening, sleeping), and hops along the taskbar when idle. Drag it to move it.
- **In-app browser** — tabs the agent can drive (open, click, type, read pages) while you watch and take over at any time.
- **Files, skills, tools, scheduled tasks** — workspace file explorer, reusable skills, MCP tools, and cron-style scheduled runs.

## Getting started (development)

Requires [Bun](https://bun.sh), Node.js 22+, and for the backend [Rust](https://rustup.rs) (on Windows also the Visual Studio C++ build tools).

The backend (AionCore) lives in `core/`. Build it once, then start the app — it picks up `core/target/release/aioncore` automatically:

```bash
bun install
bun run core:build
bun run start
```

Without Rust, download the pinned stock backend instead and point the app at it:

```bash
node scripts/prepareAioncore.js
AIONUI_BACKEND_BIN="resources/bundled-aioncore/win32-x64/aioncore.exe" bun run start
```

Checks:

```bash
bunx tsc --noEmit
bun run lint
bun run test
```

Backend updates from upstream AionCore: `git subtree pull --prefix=core https://github.com/iOfficeAI/AionCore main --squash`.

## Robot art

Animation frames live in `assets/ai-robot-concepts/animation-strips-v1/frames-30fps/<state>/` (see `animation-30fps-manifest.json`); brand images in `assets/branding/`. After changing them, rebuild the sprite strips and app icons:

```bash
node tools/build-robot-sprites.cjs
node tools/build-app-icons.cjs
```

## License

Apache-2.0 — see [LICENSE](LICENSE).
