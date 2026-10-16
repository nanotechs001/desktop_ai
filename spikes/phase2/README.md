# Phase 2 debugger spike (throwaway, deleted in Task 11)

Probes `webContents.debugger` on an Electron `<webview>` guest: OOPIF auto-attach, isolated worlds, Input over OOPIFs,
frame offsets, HTML5 drag, DevTools conflict, double attach. Prints one JSON object, then quits (~15s).

```bash
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron spikes/phase2/probe.cjs
```
