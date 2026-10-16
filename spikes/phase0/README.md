# Phase 0 spike (throwaway, deleted in Task 16)

Streams a real Google Chrome (launched over `--remote-debugging-pipe`, temp profile) into an Electron `<img>` via
`Page.startScreencast`, forwards mouse, wheel and keys back, and measures the pane's feasibility.

```bash
npx electron spikes/phase0/main.cjs [--url <u>]   # manual: drive it by hand, prints displayed fps every second
npx electron spikes/phase0/main.cjs --auto        # runs measurements #1-#10, prints RESULTS json, writes $TMPDIR/phase0-results.json
bash spikes/phase0/claude-latency.sh              # Claude CLI driver latency (needs a signed-in claude)
```

Notes: the viewer is placed on the first dpr-2 display; Chrome is placed so its right/bottom edge peeks out from behind
the viewer. `--auto` overwrites your text clipboard briefly (restored) and opens/closes Chrome and Electron windows.

Close the viewer window to quit (this also closes Chrome and removes its temp profile). `ONLY=m8_select,m9_paste` limits `--auto` to the named steps.
