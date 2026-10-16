/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Functions act runs with Runtime.callFunctionOn in our isolated world of a frame, next to snapshot.js's
 * window.__aionFast. Kept as source strings (not compiled functions) so the bundler never rewrites them; arguments
 * arrive as CDP call arguments, never spliced into code. Ported from jev-ultrafast's act path (browser.py, MIT).
 */

/**
 * (node, pageKey, guard, hitTest) → `{stale}` or `{rect, role, label, editable, options?}`, rect frame-local.
 * jev's freshness: the frame's page key and the target's guard must hash to what observe saw; the center must be
 * inside the frame's viewport and, with hitTest, elementFromPoint there (through open shadow roots) is the target.
 */
export const RESOLVE_TARGET = `function (node, pageKey, guard, hitTest) {
  const c = window.__aionFast;
  if (!c || c.hash(c.pageKey()) !== pageKey) return { stale: 'the page changed since observe' };
  const e = c.nodes.get(node);
  const now = e ? c.guard(e) : null;
  if (!now || c.hash(now) !== guard) return { stale: 'the target changed since observe' };
  const r = e.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  if (!(r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)) {
    return { stale: 'the target is off-screen' };
  }
  if (hitTest) {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    let up = hit;
    while (up && up !== e) up = up.parentNode || up.host;
    if (!up) return { stale: 'the target is covered by another element' };
  }
  return {
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    role: now[1],
    label: String(now[2]).slice(0, 200),
    editable: !e.readOnly && e.getAttribute('aria-readonly') !== 'true',
    options:
      e.tagName === 'SELECT'
        ? [...e.options].filter((o) => !o.disabled && !o.closest('optgroup[disabled]')).map((o) => o.label)
        : undefined,
  };
}`;

/**
 * The one in-page source of "what does this control say it does", shared by {@link ENTER_LABELS} and
 * {@link POINT_LABELS}: `labelsOf(e)` is the observe name (window.__aionFast.guard) when the frame was observed,
 * plus the control's own text (aria-label, value of a button input, text, title, alt); a text field says only what
 * it is labelled as (aria-label, labels, title, placeholder), never what is typed in it. Page text, cut to 200 chars.
 */
const LABELS_OF = `const buttonLike = ['button', 'submit', 'reset', 'image'];
  const isField = (e) =>
    e.matches('textarea,select,[contenteditable]:not([contenteditable="false"])') ||
    (e.tagName === 'INPUT' && !buttonLike.includes(e.type) && e.type !== 'checkbox' && e.type !== 'radio');
  const labelsOf = (e) => {
    let named = '';
    try {
      const c = window.__aionFast;
      const g = c && c.guard ? c.guard(e) : null;
      named = g && g[2] ? String(g[2]) : '';
    } catch {
      named = '';
    }
    const parts = isField(e)
      ? [e.getAttribute('aria-label'), [...(e.labels || [])].map((l) => l.textContent).join(' '), e.title, e.placeholder]
      : [e.getAttribute('aria-label'), buttonLike.includes(e.type) ? e.value : '', e.innerText || e.textContent, e.title, e.alt];
    const text = parts.filter((part) => typeof part === 'string' && part.trim()).join(' ');
    return [...new Set([named, text].filter(Boolean).map((label) => label.slice(0, 200)))];
  };`;

/**
 * (node, key) → `{labels, framed, focused}` for a gated key press. The control is the observed `node` or, when
 * node is null, the focused element (through open shadow roots). Enter: its labels (a text field's own label too,
 * e.g. a composer) and those of every submit button its form has, `form="id"` buttons and image inputs included.
 * Space: the control's labels, unless it is a text field (a space typed there activates nothing). Arrow (all four),
 * Home, End and Page keys: on a native select, its labels and options (the value changes); elsewhere nothing. `framed`: the
 * focus is on an iframe element, so the real target is in another frame; `focused`: this document has focus.
 */
export const ENTER_LABELS = `function (node, key) {
  const c = window.__aionFast;
  ${LABELS_OF}
  let e = node === null ? document.activeElement : c && c.nodes.get(node);
  while (node === null && e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  const none = { labels: [], framed: false, focused: document.hasFocus() };
  if (!e || e === document.body || e === document.documentElement) return none;
  if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') return { ...none, framed: true };
  if (key !== 'Enter' && key !== 'Space') {
    // Arrow, Home, End and Page keys only change a native select (left/right too, on Windows and Linux): any of its
    // options may be what they land on. Elsewhere they scroll or move a caret and activate nothing.
    if (e.tagName !== 'SELECT') return none;
    const options = [...e.options].slice(0, 100).map((o) => o.label.slice(0, 200));
    return { ...none, labels: [...labelsOf(e), ...options] };
  }
  const labels = key === 'Enter' || !isField(e) ? labelsOf(e) : [];
  const form = key === 'Enter' && e.tagName !== 'TEXTAREA' && !e.isContentEditable && (e.form || e.closest('form'));
  if (form) {
    const submit = [...form.elements].find((x) => x.type === 'submit');
    if (submit) labels.push(...labelsOf(submit));
    const images = [...form.querySelectorAll('input[type="image"]')];
    // An image button outside the form names it with form="id".
    if (form.id) images.push(...document.querySelectorAll('input[type="image"][form="' + CSS.escape(form.id) + '"]'));
    for (const image of new Set(images)) labels.push(...labelsOf(image));
  }
  return { ...none, labels };
}`;

/**
 * (x, y) → `{labels, framed}` for the frame-local point, for a click_point, a drag's release or the click of an act.
 * The topmost element there (through open shadow roots) and every ancestor up to the body that is a control (observe's
 * roles, links, buttons, fields, `label`, `summary`), or the outermost element of a pointer-cursor run (a `div` with
 * a click handler; `cursor` is inherited, so only the first of a run counts), each contribute their labels: an icon
 * inside a Delete button says Delete. A label also gives its control's text. Total bounded to 600 chars. `framed`:
 * the hit is an iframe element, so what is under the point is in another frame.
 */
export const POINT_LABELS = `function (x, y) {
  ${LABELS_OF}
  let hit = document.elementFromPoint(x, y);
  while (hit && hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit || hit === document.body || hit === document.documentElement) return { labels: [], framed: false };
  if (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME') return { labels: [], framed: true };
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio', 'option',
    'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton'];
  const control = 'button,a,input,select,textarea,summary,label,' + roles.map((role) => '[role="' + role + '"]').join(',');
  const pointer = (node) => getComputedStyle(node).cursor === 'pointer';
  const found = [...labelsOf(hit)];
  for (let node = hit; node && node !== document.body; node = node.parentNode || node.host) {
    if (node.nodeType !== 1) continue;
    const parent = node.parentNode || node.host;
    const outermostPointer = pointer(node) && !(parent && parent.nodeType === 1 && pointer(parent));
    if (!node.matches(control) && !outermostPointer) continue;
    found.push(...labelsOf(node), ...(node.control ? labelsOf(node.control) : []));
  }
  const labels = [];
  let total = 0;
  for (const label of new Set(found)) {
    if (total >= 600) break;
    labels.push(label.slice(0, 600 - total));
    total += label.length;
  }
  return { labels, framed: false };
}`;

/** (node, label) → true once the first enabled option of a native select with exactly that label is chosen. */
export const SELECT_OPTION = `function (node, label) {
  const e = window.__aionFast && window.__aionFast.nodes.get(node);
  if (!e || e.tagName !== 'SELECT') return false;
  const option = [...e.options].find((o) => !o.disabled && !o.closest('optgroup[disabled]') && o.label === label);
  if (!option) return false;
  e.value = option.value;
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

/**
 * (owner, x, y) → true when the topmost element at (x, y) of this document is `owner` (an iframe element resolved
 * into this world), passing through open shadow roots and through same-origin iframes in between (whose documents
 * this world can read). A cover in any document on the way makes it false.
 */
export const OWNER_HIT = `function (owner, x, y) {
  let doc = document;
  for (let depth = 0; depth < 10; depth++) {
    let hit = doc.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit) return false;
    if (hit === owner) return true;
    let inner = null;
    try {
      inner = hit.tagName === 'IFRAME' || hit.tagName === 'FRAME' ? hit.contentDocument : null;
    } catch {
      inner = null;
    }
    if (!inner) return false;
    const r = hit.getBoundingClientRect();
    const style = getComputedStyle(hit);
    x -= r.left + hit.clientLeft + parseFloat(style.paddingLeft);
    y -= r.top + hit.clientTop + parseFloat(style.paddingTop);
    doc = inner;
  }
  return false;
}`;

/**
 * (comboboxNode) → resolves after two animation frames or 50 ms; for a combobox node, once its options show,
 * capped at 200 ms (spec §4 settle wait).
 */
export const SETTLE = `function (comboboxNode) {
  const field = comboboxNode === null ? null : window.__aionFast && window.__aionFast.nodes.get(comboboxNode);
  return new Promise((resolve) => {
    let frames = 0;
    let stopped = false;
    const finish = () => {
      stopped = true;
      resolve();
    };
    setTimeout(finish, field ? 200 : 50);
    const shown = () => {
      const ids = ((field && (field.getAttribute('aria-controls') || field.getAttribute('aria-owns'))) || '')
        .split(/\\s+/)
        .filter(Boolean);
      const roots = ids.length ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [document];
      return roots.some((root) =>
        [...root.querySelectorAll('[role="option"]')].some((o) => {
          const r = o.getBoundingClientRect();
          return r.width && r.height && r.bottom > 0 && r.top < innerHeight && o.checkVisibility({ checkOpacity: true });
        })
      );
    };
    const ready = () => {
      if (stopped) return;
      if (++frames >= 2 && (!field || shown())) finish();
      else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  });
}`;

/** () → device px per CSS px (includes the pane's zoom). */
export const DEVICE_PIXEL_RATIO = `function () {
  return devicePixelRatio;
}`;
