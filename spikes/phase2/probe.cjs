// Throwaway spike: drive an Electron <webview> guest (incl. OOPIFs) via webContents.debugger.
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const FIX = path.join(__dirname, 'fixture');
const results = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => (e instanceof Error ? e.message : String(e));
/** Each measurement is independent: a throw is recorded, never fatal. */
const step = async (name, fn) => {
  try {
    results[name] = { ok: true, ...(await fn()) };
  } catch (e) {
    results[name] = { ok: false, error: errText(e) };
  }
};

const serve = (portHolder) =>
  new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const f = path.join(FIX, req.url === '/' ? 'page.html' : req.url.split('?')[0]);
      if (!f.startsWith(FIX) || !fs.existsSync(f)) return res.writeHead(404).end();
      res.setHeader('content-type', 'text/html');
      res.end(fs.readFileSync(f, 'utf8').replace('__B__', String(portHolder.b)));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });

app.whenReady().then(async () => {
  const ports = { b: 0 };
  const srvA = await serve(ports);
  const srvB = await serve(ports);
  ports.b = srvB.address().port;
  const urlA = `http://127.0.0.1:${srvA.address().port}/page.html`;

  const win = new BrowserWindow({
    width: 420,
    height: 380,
    x: 20,
    y: 20,
    show: false,
    webPreferences: { webviewTag: true, contextIsolation: true },
  });
  win.showInactive();
  const guestP = new Promise((resolve) =>
    app.on('web-contents-created', (_e, wc) => wc.getType() === 'webview' && resolve(wc))
  );
  win.loadURL(
    `data:text/html,<body style="margin:0"><webview partition="persist:spike" src="${urlA}" style="width:400px;height:360px"></webview>`
  );
  const wc = await guestP;
  await new Promise((r) => wc.once('did-finish-load', r));
  await sleep(1500); // iframes finish loading
  wc.focus();

  const dbg = wc.debugger;
  const events = [];
  dbg.on('message', (_e, method, params, sessionId) => events.push({ method, params, sessionId }));
  const send = (method, params = {}, sid) =>
    sid ? dbg.sendCommand(method, params, sid) : dbg.sendCommand(method, params);
  const ev = async (expr, sid, extra = {}) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, ...extra }, sid);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result.value;
  };
  const shared = {}; // oopif sessionId etc., shared across steps

  await step('m1_autoattach', async () => {
    dbg.attach('1.3');
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
    await sleep(800);
    const att = events.filter((e) => e.method === 'Target.attachedToTarget');
    const oopif = att.find((e) => /localhost/.test(e.params.targetInfo.url));
    if (!oopif)
      throw new Error(
        'no attachedToTarget for localhost iframe; got ' + JSON.stringify(att.map((a) => a.params.targetInfo))
      );
    shared.sid = oopif.params.sessionId;
    shared.oopifTargetId = oopif.params.targetInfo.targetId;
    // sessionId is the 3rd arg of sendCommand
    const title = await ev('document.title', shared.sid);
    shared.crossFrameId = (await send('Page.getFrameTree', {}, shared.sid)).frameTree.frame.id;
    return {
      sessionId: shared.sid,
      targetInfo: oopif.params.targetInfo,
      evalViaChildSession: title,
      otherAttached: att.map((a) => a.params.targetInfo.type + ':' + a.params.targetInfo.url),
    };
  });

  const tree = (await send('Page.getFrameTree').catch(() => null))?.frameTree;
  const children = tree?.childFrames?.map((c) => c.frame) ?? [];
  const sameFrame = children.find((f) => /same\.html/.test(f.url));
  // OOPIF is absent from the top session's frame tree; its frame id comes from the child session (== targetId).
  const crossFrame = { id: shared.crossFrameId };
  results.frameTree = children.map((f) => ({ id: f.id, url: f.url }));
  results.oopifInTopFrameTree = children.some((f) => /oopif\.html/.test(f.url));

  await step('m2_isolated_worlds', async () => {
    const out = {};
    const w = await send('Page.createIsolatedWorld', { frameId: sameFrame.id, worldName: 'spike' });
    out.sameOrigin = await ev('document.title+"|"+location.host', undefined, { contextId: w.executionContextId });
    const childTree = (await send('Page.getFrameTree', {}, shared.sid)).frameTree.frame;
    const w2 = await send('Page.createIsolatedWorld', { frameId: childTree.id, worldName: 'spike' }, shared.sid);
    out.oopifChildSession = await ev('document.title+"|"+location.host', shared.sid, {
      contextId: w2.executionContextId,
    });
    // does the main session see the OOPIF frame id in createIsolatedWorld? (expected to fail)
    try {
      await send('Page.createIsolatedWorld', { frameId: crossFrame.id, worldName: 'spike' });
      out.oopifFromTopSession = 'worked';
    } catch (e) {
      out.oopifFromTopSession = errText(e);
    }
    out.childFrameIdEqualsTargetId = childTree.id === shared.oopifTargetId;
    return out;
  });

  /** Iframe element offset (top-viewport CSS px) via DOM.getFrameOwner + DOM.getBoxModel. */
  const frameOffset = async (frameId) => {
    const { backendNodeId } = await send('DOM.getFrameOwner', { frameId });
    const { model } = await send('DOM.getBoxModel', { backendNodeId });
    return { x: model.content[0], y: model.content[1], w: model.width, h: model.height };
  };
  const rectIn = (sel, sid) =>
    ev(`(r=>({x:r.x,y:r.y,w:r.width,h:r.height}))(document.querySelector('${sel}').getBoundingClientRect())`, sid);

  await step('m4_frame_offset', async () => {
    await send('DOM.enable');
    await send('DOM.getDocument', { depth: 0 });
    const domSame = await frameOffset(sameFrame.id);
    const domCross = await frameOffset(crossFrame.id);
    const truthSame = await ev("(r=>({x:r.x,y:r.y}))(document.getElementById('same').getBoundingClientRect())");
    const truthCross = await ev("(r=>({x:r.x,y:r.y}))(document.getElementById('cross').getBoundingClientRect())");
    return { domSame, domCross, truthSame, truthCross, dpr: await ev('devicePixelRatio') };
  });

  const mouse = (type, x, y, extra = {}) =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      ...extra,
    });
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await mouse('mousePressed', x, y);
    await mouse('mouseReleased', x, y);
  };

  await step('m3_input_into_oopif', async () => {
    const off = await frameOffset(crossFrame.id);
    const btn = await rectIn('#b', shared.sid);
    const inp = await rectIn('#i', shared.sid);
    await click(off.x + btn.x + btn.w / 2, off.y + btn.y + btn.h / 2);
    await sleep(200);
    const clicks = await ev('window.clicks||0', shared.sid);
    await click(off.x + inp.x + inp.w / 2, off.y + inp.y + inp.h / 2);
    await send('Input.insertText', { text: 'hello' });
    await sleep(200);
    const typedTop = await ev("document.getElementById('i').value", shared.sid);
    // insertText / mouse sent on the child session instead (refocus the input first)
    await click(off.x + inp.x + inp.w / 2, off.y + inp.y + inp.h / 2);
    await send('Input.insertText', { text: 'X' }, shared.sid).catch((e) => (shared.childInsertErr = errText(e)));
    await sleep(100);
    const afterChildInsert = await ev("document.getElementById('i').value", shared.sid);
    await send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: btn.x + 5, y: btn.y + 5, button: 'left', clickCount: 1 },
      shared.sid
    ).catch((e) => (shared.childMouseErr = errText(e)));
    await send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: btn.x + 5, y: btn.y + 5, button: 'left', clickCount: 1 },
      shared.sid
    ).catch(() => {});
    await sleep(200);
    const clicksAfterChildMouse = await ev('window.clicks||0', shared.sid);
    // same-origin iframe via top session for comparison
    const offS = await frameOffset(sameFrame.id);
    const sb = await ev(
      "(r=>({x:r.x,y:r.y,w:r.width,h:r.height}))(document.getElementById('same').contentDocument.getElementById('b').getBoundingClientRect())"
    );
    await click(offS.x + sb.x + sb.w / 2, offS.y + sb.y + sb.h / 2);
    await sleep(200);
    const sameClicks = await ev("document.getElementById('same').contentWindow.clicks||0");
    return {
      buttonClicksViaTopSession: clicks,
      inputValueAfterTopInsertText: typedTop,
      sameOriginClicks: sameClicks,
      inputValueAfterChildSessionInsertText: afterChildInsert,
      childInsertErr: shared.childInsertErr,
      clicksAfterChildSessionMouse: clicksAfterChildMouse,
      childMouseErr: shared.childMouseErr,
    };
  });

  await step('m5_html5_drag', async () => {
    const r = (id) =>
      ev(`(r=>({x:r.x+r.width/2,y:r.y+r.height/2}))(document.getElementById('${id}').getBoundingClientRect())`);
    const a = await r('d1');
    const b = await r('d3');
    await send('Input.setInterceptDrags', { enabled: true });
    events.length = 0;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y });
    await mouse('mousePressed', a.x, a.y);
    for (let i = 1; i <= 5; i++)
      await mouse('mouseMoved', a.x + ((b.x - a.x) * i) / 5, a.y + ((b.y - a.y) * i) / 5, { buttons: 1 });
    await sleep(200);
    const intercepted = events.find((e) => e.method === 'Input.dragIntercepted');
    if (!intercepted) throw new Error('no Input.dragIntercepted event');
    const data = intercepted.params.data;
    for (const type of ['dragEnter', 'dragOver', 'drop'])
      await send('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data });
    await mouse('mouseReleased', b.x, b.y, { buttons: 0 });
    await send('Input.setInterceptDrags', { enabled: false });
    await sleep(200);
    return {
      interceptedItems: data.items?.length,
      dropLog: await ev('window.dropLog'),
      order: await ev("[...document.querySelectorAll('li')].map(l=>l.id).join(',')"),
    };
  });

  await step('m7_double_attach', async () => {
    const out = { isAttached: dbg.isAttached() };
    try {
      dbg.attach('1.3');
      out.secondAttach = 'no error';
    } catch (e) {
      out.secondAttach = errText(e);
    }
    out.stillWorks = await ev('1+1'); // first attachment unaffected
    // second 'message' listener (as the old cdpBridge would add) receives events alongside ours
    let seen = 0;
    const l = () => seen++;
    dbg.on('message', l);
    await ev('1');
    await send('Runtime.evaluate', { expression: 'console.log(1)' });
    await sleep(100);
    dbg.removeListener('message', l);
    out.secondListenerSawEvents = seen;
    return out;
  });

  await step('m6_devtools_conflict', async () => {
    const out = {};
    // (a) debugger attached first, then open DevTools
    const detached = new Promise((r) => dbg.once('detach', (_e, reason) => r(reason)));
    wc.openDevTools({ mode: 'detach', activate: false });
    await Promise.race([new Promise((r) => wc.once('devtools-opened', r)), sleep(3000)]);
    out.openDevToolsWhileAttached = {
      devToolsOpened: wc.isDevToolsOpened(),
      detachReason: await Promise.race([detached, sleep(1500).then(() => 'no detach event')]),
      stillAttached: dbg.isAttached(),
    };
    out.evalAfterDevToolsOpen = await ev('1+1').catch((e) => 'ERR ' + errText(e));
    out.childEvalAfterDevToolsOpen = await ev('document.title', shared.sid).catch((e) => 'ERR ' + errText(e));
    // (b) DevTools open, fresh attach attempt
    if (dbg.isAttached()) dbg.detach();
    try {
      dbg.attach('1.3');
      out.attachWhileDevToolsOpen = 'no error';
    } catch (e) {
      out.attachWhileDevToolsOpen = errText(e);
    }
    wc.closeDevTools();
    await sleep(800);
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
      out.attachAfterDevToolsClosed = 'ok';
    } catch (e) {
      out.attachAfterDevToolsClosed = errText(e);
    }
    return out;
  });

  console.log('RESULTS ' + JSON.stringify(results, null, 1));
  fs.writeFileSync(path.join(require('node:os').tmpdir(), 'phase2-results.json'), JSON.stringify(results, null, 1));
  app.exit(0);
});

setTimeout(() => {
  console.log('RESULTS ' + JSON.stringify({ ...results, timeout: true }));
  app.exit(1);
}, 50000);
