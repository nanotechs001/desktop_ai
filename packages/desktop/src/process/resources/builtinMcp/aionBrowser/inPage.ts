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

/** (node, index) → true once the index-th enabled option of a native select is chosen and input/change fired. */
export const SELECT_OPTION = `function (node, index) {
  const e = window.__aionFast && window.__aionFast.nodes.get(node);
  if (!e || e.tagName !== 'SELECT') return false;
  const option = [...e.options].filter((o) => !o.disabled && !o.closest('optgroup[disabled]'))[index];
  if (!option) return false;
  e.value = option.value;
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
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
