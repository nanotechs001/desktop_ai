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
 * (node) → labels of what an Enter press may activate: the control (the observed `node`, or the focused element
 * when `node` is null) unless it is a text field, and the submit button of its form, which Enter submits. Needs
 * no snapshot state, so an unobserved page is covered too. Labels are the page's own text, cut to 200 chars.
 */
export const ENTER_LABELS = `function (node) {
  const c = window.__aionFast;
  let e = node === null ? document.activeElement : c && c.nodes.get(node);
  while (node === null && e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  if (!e || e === document.body || e === document.documentElement) return [];
  const buttonLike = ['button', 'submit', 'reset', 'image'];
  const label = (x) =>
    [x.getAttribute('aria-label'), buttonLike.includes(x.type) ? x.value : '', x.innerText || x.textContent, x.title, x.alt]
      .filter((part) => typeof part === 'string' && part.trim())
      .join(' ')
      .slice(0, 200);
  const field = e.matches('textarea,select,[contenteditable]:not([contenteditable="false"]),input:not(' +
    buttonLike.map((type) => '[type="' + type + '"]').join(',') + ',[type="checkbox"],[type="radio"])');
  const labels = field ? [] : [label(e)];
  const form = e.form || e.closest('form');
  const submit = form && e.tagName !== 'TEXTAREA' && form.querySelector(
    'button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]'
  );
  if (submit) labels.push(label(submit));
  return labels;
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
