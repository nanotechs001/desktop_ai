// Phase 0 spike (throwaway): stream real Chrome into an Electron <img> via CDP screencast. See README.md.
const { app, BrowserWindow, clipboard, ipcMain, screen } = require('electron');
const { spawn, execSync } = require('child_process');
const fs = require('fs'),
  os = require('os'),
  path = require('path');
const { pathToFileURL } = require('url');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURE = pathToFileURL(path.join(__dirname, 'fixture.html')).href;
const AUTO = process.argv.includes('--auto');
const START_URL = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : FIXTURE;
const W = 1280,
  H = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => a.toSorted((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
const sh = (c) => {
  try {
    return execSync(c, { encoding: 'utf8' });
  } catch (e) {
    return String(e.message);
  }
};
const frontName = () => sh('lsappinfo info -only name $(lsappinfo front)').split('=')[1].trim();
// OS truth (no permission needed): our two apps' on-screen windows, front-to-back, as "E|C<layer> x,y wxh"
const osWins = () =>
  JSON.parse(
    sh(
      `osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))).filter(w => [${process.pid}, ${chrome.pid}].includes(w.kCGWindowOwnerPID)).map(w => [w.kCGWindowOwnerPID, w.kCGWindowLayer, w.kCGWindowBounds]))'`
    )
  ).map(([pid, l, b]) => `${pid === chrome.pid ? 'C' : 'E'}${l} ${b.X},${b.Y} ${b.Width}x${b.Height}`);
const frontPid = () => +(/"pid"=(\d+)/.exec(sh('lsappinfo info -only pid $(lsappinfo front)')) || [])[1];

let win,
  chrome,
  profile,
  A,
  winId,
  lastData,
  lastW,
  lastRgb,
  D,
  nextId = 0,
  buf = '',
  watch = null,
  quitting = false;
const pending = new Map(),
  frames = {},
  shown = [];

// ---- CDP over --remote-debugging-pipe (NUL-delimited JSON on fd 3 -> Chrome, fd 4 <- Chrome) ----
function cdp(method, params = {}, tab) {
  return new Promise((res, rej) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`timeout ${method}`));
    }, 8000);
    pending.set(id, { res, rej, method, timer });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId: tab && tab.s }) + '\0');
  });
}
function onData(chunk) {
  const parts = (buf + chunk).split('\0');
  buf = parts.pop();
  for (const p of parts) {
    const m = JSON.parse(p),
      q = pending.get(m.id);
    if (q) {
      pending.delete(m.id);
      clearTimeout(q.timer);
      if (m.error) q.rej(new Error(`${q.method}: ${m.error.message}`));
      else q.res(m.result);
    } else if (m.method === 'Page.screencastFrame') onFrame(m);
  }
}
function onFrame(m) {
  const { data, sessionId: token } = m.params; // params.sessionId is the frame-ack token, m.sessionId is the CDP session
  frames[m.sessionId] = (frames[m.sessionId] || 0) + 1;
  if (m.sessionId !== A.s)
    return void cdp('Page.screencastFrameAck', { sessionId: token }, { s: m.sessionId }).catch(() => {});
  lastData = data;
  if (!win.isDestroyed()) win.webContents.send('frame', { data, token, sess: m.sessionId });
}
// viewer reports a frame decoded+sampled: that is "displayed"; only now do we ack so Chrome paces to the viewer
ipcMain.on('shown', (_, m) => {
  const t = performance.now();
  shown.push(t);
  lastW = m.w;
  if (m.rgb) lastRgb = m.rgb;
  cdp('Page.screencastFrameAck', { sessionId: m.token }, { s: m.sess }).catch(() => {});
  if (watch && m.rgb && m.rgb[0] > m.rgb[2] === watch.want) {
    const hit = watch;
    watch = null;
    hit.res(t);
  }
});
ipcMain.on('cdp', (_, method, params) => method.startsWith('Input.') && cdp(method, params, A).catch(() => {}));

// ---- helpers ----
const ev = async (expr, tab = A) =>
  (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, tab)).result.value;
const mouse = (type, x, y, extra = {}, tab = A) =>
  cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra }, tab);
const click = async ({ x, y }, tab = A) => {
  await mouse('mousePressed', x, y, {}, tab);
  await mouse('mouseReleased', x, y, {}, tab);
};
const center = (sel, tab = A) =>
  ev(
    `(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.querySelector('${sel}').getBoundingClientRect())`,
    tab
  );
const cast = (tab) =>
  cdp('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 3840, maxHeight: 2400, everyNthFrame: 1 }, tab);
const waitShown = (want, ms = 2000) =>
  new Promise((res) => {
    const t = setTimeout(() => {
      watch = null;
      res(null);
    }, ms);
    watch = {
      want,
      res: (v) => {
        clearTimeout(t);
        res(v);
      },
    };
  });
const save = (name) => {
  const f = path.join(os.tmpdir(), name);
  fs.writeFileSync(f, Buffer.from(lastData, 'base64'));
  return f;
};
async function activate() {
  win.show();
  app.focus({ steal: true });
  win.focus();
  await sleep(700);
  return frontPid() === process.pid;
}
async function attach(targetId) {
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const tab = { targetId, s: sessionId };
  await cdp('Page.enable', {}, tab);
  return tab;
}
// Put Chrome's content area (not its window) exactly on screen rect R, using the measured UI delta.
async function place(R) {
  const [dw, dh] = await ev('[outerWidth - innerWidth, outerHeight - innerHeight]');
  await cdp('Browser.setWindowBounds', {
    windowId: winId,
    bounds: { left: R.x, top: R.y - dh, width: R.w + dw, height: R.h + dh },
  });
  await sleep(600);
  const [sx, sy, iw, ih, odh] = await ev('[screenX, screenY, innerWidth, innerHeight, outerHeight - innerHeight]');
  const got = { x: sx, y: sy + odh, w: iw, h: ih };
  return {
    delta: [dw, dh],
    got,
    maxErrPx: Math.max(Math.abs(got.x - R.x), Math.abs(got.y - R.y), Math.abs(got.w - R.w), Math.abs(got.h - R.h)),
  };
}

// ---- measurements ----
async function scrollFps(sec = 10) {
  // #1 / #3: wheel-scroll the fixture at ~60 Hz, count displayed frames per second
  await ev('scrollTo(0, 0)');
  await sleep(500);
  shown.length = 0;
  const t0 = performance.now();
  const iv = setInterval(() => mouse('mouseWheel', 400, 400, { deltaX: 0, deltaY: 30 }).catch(() => {}), 16);
  await sleep(sec * 1000);
  clearInterval(iv);
  const b = Array(sec).fill(0);
  for (const t of shown) b[Math.min(sec - 1, Math.floor((t - t0) / 1000))]++;
  return {
    medianFps: median(b),
    meanFps: shown.length / sec,
    perSecond: b,
    frameWidthPx: lastW,
    visibility: await ev('document.visibilityState'),
  };
}
async function latency(n = 30) {
  // #2: dispatch click -> first displayed frame whose block colour flipped
  const btn = await center('#toggle');
  win.webContents.send('sample', await center('#block'));
  await sleep(500);
  const lat = [],
    diag = [];
  for (let i = 0; i < n; i++) {
    await sleep(300 + Math.random() * 200);
    const p = waitShown(!(await ev("document.querySelector('#block').className === 'red'")));
    const t0 = performance.now();
    await click(btn);
    const t1 = await p;
    lat.push(t1 && t1 - t0);
    if (!t1)
      diag.push({
        i,
        classNow: await ev("document.querySelector('#block').className"),
        lastRgb,
        framesSinceClick: shown.filter((t) => t > t0).length,
      });
  }
  const ok = lat.filter((x) => x !== null);
  return {
    n,
    timeouts: n - ok.length,
    p50Ms: median(ok),
    p90Ms: ok.toSorted((a, b) => a - b)[Math.floor(ok.length * 0.9)],
    maxMs: Math.max(...ok),
    samplesMs: lat.map((x) => x && Math.round(x)),
    diag,
  };
}
async function occluded() {
  // #3: viewer (always-on-top) fully covers Chrome's window
  const cb = (await cdp('Browser.getWindowBounds', { windowId: winId })).bounds,
    orig = win.getBounds();
  win.setAlwaysOnTop(true, 'floating');
  win.setBounds({
    x: cb.left - 10,
    y: Math.max(cb.top - 10, D.workArea.y),
    width: cb.width + 20,
    height: cb.height + 20,
  });
  const electronFront = await activate();
  const eb = win.getBounds(),
    osZ = osWins();
  const m = await scrollFps();
  win.setAlwaysOnTop(false);
  win.setBounds(orig);
  return {
    ...m,
    electronFront,
    osZ,
    chromeBounds: cb,
    electronBounds: eb,
    fullyCovered:
      eb.x <= cb.left &&
      eb.y <= cb.top &&
      eb.x + eb.width >= cb.left + cb.width &&
      eb.y + eb.height >= cb.top + cb.height,
  };
}
async function focusSteal(background) {
  // #4
  const before = await activate();
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank', background });
  await sleep(1500);
  const after = {
    frontName: frontName(),
    frontPid: frontPid(),
    frontIsChrome: frontPid() === chrome.pid,
    electronWinFocused: win.isFocused(),
  };
  await cdp('Target.closeTarget', { targetId });
  await sleep(500);
  return { background, electronFrontBefore: before, after, stoleFocus: before && after.frontPid !== process.pid };
}
async function bringToFront() {
  // #5
  const electronFront = await activate();
  const zBefore = osWins();
  await cdp('Page.bringToFront', {}, A);
  await sleep(1200);
  const zAfter = osWins();
  const viaBringToFront = frontPid() === chrome.pid;
  return { electronFront, viaBringToFront, zBefore, zAfter }; // `open -a "Google Chrome"` fallback not needed
}
async function backgroundTab() {
  // #6 + #7
  const { targetId } = await cdp('Target.createTarget', { url: FIXTURE, background: true });
  const B = await attach(targetId);
  await sleep(1500);
  const vis = { A: await ev('document.visibilityState'), B: await ev('document.visibilityState', B) };
  frames[B.s] = 0;
  await cast(B);
  const iv = setInterval(() => ev("document.querySelector('#toggle').click()", B).catch(() => {}), 100);
  await sleep(3000);
  clearInterval(iv);
  const m6 = { visibility: vis, framesIn3s: frames[B.s] };
  const read = () => ev("+document.querySelector('#count').textContent", B);
  const c0 = await read();
  await click(await center('#counter', B), B).catch(() => {});
  await sleep(300);
  const c1 = await read();
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }, B);
  await click(await center('#counter', B), B).catch(() => {});
  await sleep(300);
  const c2 = await read();
  await cdp('Target.closeTarget', { targetId });
  return { m6, m7: { incrementWithoutFocusEmulation: c1 - c0, incrementWithFocusEmulation: c2 - c1 } };
}
async function paste() {
  // #9
  const electronFront = await activate();
  const old = clipboard.readText(),
    tok = `PASTE-${Date.now()}`;
  clipboard.writeText(tok);
  await ev("(t => { t.value = ''; t.focus(); })(document.querySelector('#txt'))");
  const key = (type, extra) =>
    cdp(
      'Input.dispatchKeyEvent',
      { type, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 4, ...extra },
      A
    );
  await key('keyDown', { commands: ['paste'] });
  await key('keyUp');
  await sleep(300);
  const viaCommand = await ev("document.querySelector('#txt').value");
  let viaInsertText = null;
  if (viaCommand !== tok) {
    await cdp('Input.insertText', { text: clipboard.readText() }, A);
    await sleep(200);
    viaInsertText = await ev("document.querySelector('#txt').value");
  }
  clipboard.writeText(old); // restore the user's text clipboard
  return { electronFront, commandPasteWorks: viaCommand === tok, viaCommand, viaInsertText };
}
async function placement() {
  // #10
  const out = [];
  for (const [dx, dy, w, h] of [
    [200, 150, 1000, 600],
    [60, 120, 900, 500],
  ]) {
    const R = { x: D.workArea.x + dx, y: D.workArea.y + dy, w, h };
    const r = await place(R);
    await mouse('mousePressed', 5, 5);
    await mouse('mouseReleased', 5, 5); // page records screenX-clientX of a CDP click
    const [mx, my] = await ev('window.md || [null, null]');
    out.push({ R, ...r, mouseEventOrigin: { x: mx, y: my }, osChromeWindow: osWins().filter((w) => w[0] === 'C') });
  }
  return out;
}
async function selectPopup() {
  // #8 (last: the native popup stays open until Chrome closes)
  await cdp('DOM.enable', {}, A);
  const c = await center('#sel'),
    [sx, sy] = await ev('[scrollX, scrollY]');
  // DOM.getNodeForLocation wants document coordinates (viewport point + scroll offset), not viewport ones
  const at = (x, y) =>
    cdp('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y) }, A)
      .then((r) => cdp('DOM.describeNode', { backendNodeId: r.backendNodeId }, A))
      .then(
        (d) => d.node.nodeName,
        (e) => e.message
      );
  const nodeName = await at(c.x + sx, c.y + sy),
    nodeNameViewportCoords = await at(c.x, c.y);
  await sleep(1500); // let the initial frame land
  const f0 = frames[A.s],
    before = save('phase0-select-before.jpg'),
    winsBefore = osWins();
  await click(c);
  await sleep(1500);
  return {
    scrollYAtTest: sy,
    nodeNameAtSelect: nodeName,
    nodeNameIfViewportCoordsUsed: nodeNameViewportCoords,
    newFramesAfterClick: frames[A.s] - f0,
    before,
    after: save('phase0-select-after.jpg'),
    winsBefore,
    winsAfter: osWins(),
  };
}
async function runAuto() {
  const R = {
    env: {
      electron: process.versions.electron,
      chrome: (await cdp('Browser.getVersion')).product,
      viewerContent: win.getContentBounds(),
      displays: screen.getAllDisplays().map((d) => ({ bounds: d.bounds, scale: d.scaleFactor })),
    },
  };
  const step = async (k, f) => {
    if (process.env.ONLY && !process.env.ONLY.includes(k)) return;
    try {
      R[k] = await f();
    } catch (e) {
      R[k] = { error: String(e) };
    }
    console.log('done', k);
  };
  await step('m1_scrollFpsVisible', scrollFps);
  await step('m2_latency', latency);
  await step('m3_scrollFpsOccluded', occluded);
  await step('m4_focusSteal', async () => {
    const r = [];
    for (const bg of [true, false, true, false]) r.push(await focusSteal(bg));
    return r;
  });
  await step('m5_bringToFront', bringToFront);
  await step('m6_m7_backgroundTab', backgroundTab);
  await step('m9_paste', paste);
  await step('m10_placement', placement);
  await step('m8_select', selectPopup);
  const out = JSON.stringify(R, null, 1);
  fs.writeFileSync(path.join(os.tmpdir(), 'phase0-results.json'), out);
  console.log('RESULTS ' + out);
}

// ---- lifecycle ----
async function boot() {
  D = screen.getAllDisplays().find((d) => d.scaleFactor >= 2) || screen.getPrimaryDisplay(); // dpr-2 (Retina) display
  win = new BrowserWindow({
    x: D.workArea.x,
    y: D.workArea.y,
    width: W,
    height: H,
    useContentSize: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false },
  });
  const loaded = new Promise((r) => win.webContents.once('did-finish-load', r));
  win.loadFile(path.join(__dirname, 'viewer.html'));
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-chrome-'));
  chrome = spawn(
    CHROME,
    [
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--restore-last-session',
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] }
  );
  chrome.stdio[4].setEncoding('utf8').on('data', onData);
  chrome.stdio[3].on('error', () => {});
  chrome.stdio[1].resume();
  chrome.stdio[2].resume();
  chrome.on('exit', () => !quitting && quit());
  let t = [];
  for (let i = 0; i < 100 && !t.length; i++) {
    await sleep(100);
    t = await cdp('Target.getTargets').then(
      (r) => r.targetInfos.filter((x) => x.type === 'page'),
      () => []
    );
  }
  A = await attach(t[0].targetId);
  winId = (await cdp('Browser.getWindowForTarget', { targetId: A.targetId })).windowId;
  await cdp('Page.navigate', { url: START_URL }, A);
  await sleep(2000);
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }, A);
  await place({ x: D.workArea.x + 150, y: D.workArea.y + 130, w: W, h: H }); // Chrome peeks out right/bottom of the viewer
  await loaded;
  await activate();
  await cast(A);
}
async function quit() {
  if (quitting) return;
  quitting = true;
  if (chrome) {
    cdp('Browser.close').catch(() => {});
    await Promise.race([new Promise((r) => chrome.once('exit', r)), sleep(4000)]);
    chrome.kill('SIGKILL');
  }
  if (profile) fs.rmSync(profile, { recursive: true, force: true }); // our own mkdtemp dir
  app.exit(0);
}
process.on('SIGINT', quit);
app.on('window-all-closed', quit);
app.whenReady().then(async () => {
  try {
    await boot();
    if (AUTO) {
      await runAuto();
      await quit();
    } else
      setInterval(
        () =>
          console.log(
            `displayed fps ${shown.filter((t) => t > performance.now() - 1000).length}, frame ${lastW}px wide`
          ),
        1000
      );
  } catch (e) {
    console.error(e);
    await quit();
  }
});
