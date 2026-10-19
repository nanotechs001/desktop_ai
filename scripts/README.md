# Scripts

Build, packaging and dev tooling for Pixebot Browser. Run them through the `package.json` scripts (or `just`) where one exists.

## Build and packaging

| Script                         | Purpose                                                                                                              |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `build-with-builder.js`        | Entry point for `dist*` / `build-*`: electron-vite build, builtin MCP bundles, backend bundle, then electron-builder |
| `build-mcp-servers.js`         | Bundles the four builtin MCP servers (`builtin-mcp-*.js`) as self-contained CJS                                      |
| `buildCore.js`                 | Release build of the Rust backend in `core/` (`bun run core:build`)                                                  |
| `prepareLocalCore.js`          | Bundles the backend built from `core/` into `resources/bundled-aioncore/<platform>-<arch>/` (default for packaging)  |
| `prepareAioncore.js`           | Downloads the stock AionCore release instead (`AIONUI_BACKEND_SOURCE=release`, needed for cross-arch builds)         |
| `resolveAioncoreVersion.js`    | Resolves the AionCore version for `prepareAioncore.js`                                                               |
| `rebuildNativeModules.js`      | Native module rebuild helper (`better-sqlite3`), used by `afterPack.js`                                              |
| `afterPack.js`, `afterSign.js` | electron-builder hooks: post-pack native module check (Linux), macOS notarization                                    |

## Development

| Script                                                           | Purpose                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `postinstall.js`                                                 | Runs after `bun install`                                                      |
| `dev-bootstrap.mjs`                                              | `just dev-ext*`: frees stale ports/processes, starts the app with `examples/` |
| `packaged-launch.mjs`                                            | Launches an unpacked build with `examples/` loaded (`just packaged-ext`)      |
| `check-i18n.js`, `generate-i18n-types.js`                        | i18n validation and key type generation (`just i18n-check`)                   |
| `smoke-installer-self-lock.js`, `smoke-installer-rstrtmgr-ui.js` | Windows installer smoke tests (`bun run test:smoke:installer:*`)              |
| `codemods/`                                                      | One-off ts-morph codemods                                                     |

## Build flow

```
bun run build-win:x64   (or dist:*, build-mac:*, build-deb)
    -> build-with-builder.js
         -> electron-vite build
         -> build-mcp-servers.js
         -> prepareLocalCore.js (or prepareAioncore.js)
         -> electron-builder
              -> afterPack.js
              -> afterSign.js (macOS)
```

CI (`.github/workflows/`) calls `build-with-builder.js` directly and publishes the `latest*.yml` updater metadata with the installers.
