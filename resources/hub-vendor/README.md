# Vendored hub extensions

Pinned copy of the upstream AionHub `dist-latest` build output (`index.json` and the `aionext-*.zip` engine extensions), so packaging builds need no network access.

- Source: <https://github.com/iOfficeAI/AionHub>, tag `dist-latest`, commit `f9570c40796cc23365970a645c0841b8d2cc7c15` (vendored 2026-10-18).
- `scripts/prepareHubResources.js` copies these files into `resources/hub/` (bundled as `hub/` in the installer) after checking each one against `hub-vendor.lock.json`. A missing or altered file fails the build.
- The files are kept byte-exact (`-text` in `.gitattributes`, ignored by the formatter). Do not edit them by hand.

What they are: each zip is a small extension (an `aion-extension.json` manifest, an icon and a `scripts/install.ts`) that registers one ACP adapter (Auggie, Claude Code, CodeBuddy, Codex, Goose, OpenCode, Qwen Code). Installing one runs `bun install` of that agent's npm packages into the app's agent install folder. The upstream `dist.integrity` values inside `index.json` do not match the zips' SHA-256; the lock file holds the real hashes.

## Refreshing

```bash
AIONUI_HUB_DOWNLOAD=1 AIONUI_HUB_TAG=<tag-or-commit> node scripts/prepareHubResources.js
```

Then copy `resources/hub/index.json` and `resources/hub/*.zip` here, update `commit`, `vendoredAt` and the `files` hashes in `hub-vendor.lock.json` (`sha256-<hex>` of each file), and review the zips' `scripts/install.ts` before committing.
