/*
 * Frame snapshot for the aion-browser `observe` tool. Evaluated as one expression in our own isolated world of
 * each frame, so the page can neither read nor forge window.__aionFast.
 *
 * Ported from jev-ultrafast (https://github.com/browser-use/jev-ultrafast, jev_ultrafast/snapshot.js).
 * Changes: walks open shadow roots; reports every contenteditable (and a designMode body) as textbox, and
 * other draggable="true" elements (builder widgets, sortable items) as draggable, for the drag tool; one
 * entry per element (a select lists its options instead of one action per option; no "Open" duplicates,
 * no scroll/wait pseudo-actions); state lives in window.__aionFast; marker, page key and guards are returned
 * as short hashes, and page strings are cut (labels, values and options to 200 chars, 50 options per select,
 * 6000 chars of text) so a 250-row snapshot stays small; aria states are kept only as true/false/mixed.
 * Rects stay frame-local, as in jev.
 *
 * MIT License
 *
 * Copyright (c) 2026 Browser Use
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(() => {
  if (!document.body) return null;
  const MAX_STRING = 200;
  const MAX_OPTIONS = 50;
  const MAX_TEXT = 6000;
  const cut = (text) => String(text).slice(0, MAX_STRING);
  const cache = (window.__aionFast ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const identity = (e) => {
    if (!cache.ids.has(e)) cache.ids.set(e, cache.next++);
    const id = cache.ids.get(e);
    cache.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  // cyrb53: a 53-bit string hash, enough to tell "changed" from "unchanged".
  cache.hash = (value) => {
    const text = JSON.stringify(value);
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  // The document plus every open shadow root under it (closed roots are unreachable by design).
  const roots = [];
  const addRoot = (root) => {
    roots.push(root);
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) addRoot(e.shadowRoot);
  };
  addRoot(document);
  const all = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  const safe = (e) => !['password', 'file', 'hidden'].includes(e.type);
  const visible = (e) =>
    !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => name(e.getRootNode().getElementById?.(id), seen))
      .filter(Boolean)
      .join(' ');
    return (
      referenced ||
      e.getAttribute('aria-label') ||
      [...(e.labels || [])]
        .map((l) => name(l, seen))
        .filter(Boolean)
        .join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') ||
      e.getAttribute('alt') ||
      (e.tagName === 'INPUT'
        ? ''
        : [...e.childNodes]
            .map((n) =>
              n.nodeType === 3
                ? n.textContent
                : n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true'
                  ? name(n, seen)
                  : ''
            )
            .join(' ')
            .trim()) ||
      e.getAttribute('title') ||
      e.getAttribute('placeholder') ||
      ''
    );
  };
  const roles = [
    'button',
    'link',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemradio',
    'option',
    'gridcell',
    'combobox',
    'textbox',
    'searchbox',
    'spinbutton',
  ];
  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable]:not([contenteditable="false"]),[draggable="true"],' +
    roles.map((role) => '[role="' + role + '"]').join(',');
  const role = (e) => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (['text', 'email', 'url', 'tel'].includes(e.type)) return 'textbox';
    }
    if (e.getAttribute('draggable') === 'true') return 'draggable';
    return null;
  };
  cache.pageKey = () => [
    performance.timeOrigin,
    location.href,
    scrollX,
    scrollY,
    innerWidth,
    innerHeight,
    all('input,textarea,select')
      .filter(safe)
      .map((e) => [identity(e), e.value, e.checked, e.selectedIndex, e.disabled, e.readOnly]),
  ];
  cache.guard = (e) => {
    if (!e?.isConnected || !visible(e)) return null;
    const scope = e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [
      identity(e),
      role(e),
      name(e),
      e.value ?? null,
      e.checked ?? null,
      e.selectedIndex ?? null,
      e.readOnly ?? null,
      e.matches(':disabled'),
      e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),
      e.getAttribute('aria-checked'),
      e.getAttribute('aria-selected'),
      e.getAttribute('href'),
      scope?.innerText?.slice(0, 6000) || '',
    ];
  };
  // A designMode document (a rich-text iframe) is one big textbox with no contenteditable attribute.
  const candidates = new Set(all(selector));
  if (document.body.isContentEditable) candidates.add(document.body);
  const actions = [];
  for (const e of candidates) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect(),
      x = r.x + r.width / 2,
      y = r.y + r.height / 2,
      rname = role(e);
    if (!rname || r.width <= 0 || r.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const base = {
      node: identity(e),
      role: rname,
      label: cut(name(e) || rname),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
    for (const key of ['checked', 'selected', 'expanded']) {
      const value = e.getAttribute('aria-' + key);
      if (['true', 'false', 'mixed'].includes(value)) base[key] = value;
    }
    if (['checkbox', 'radio'].includes(e.type)) base.checked = String(e.checked);
    if (e.tagName === 'SELECT') {
      const options = [...e.options].filter((o) => !o.disabled && !o.closest('optgroup[disabled]'));
      const more = options.length > MAX_OPTIONS ? ['+' + (options.length - MAX_OPTIONS) + ' more'] : [];
      actions.push({
        ...base,
        kind: 'select',
        value: cut([...e.selectedOptions].map((o) => o.label).join(', ')),
        options: [...options.slice(0, MAX_OPTIONS).map((o) => cut(o.label)), ...more],
      });
    } else {
      const editable =
        !e.readOnly &&
        e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) ||
          (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)));
      const value =
        'value' in e ? String(e.value) : e.isContentEditable || rname === 'combobox' ? e.innerText.trim() : '';
      actions.push({ ...base, kind: editable ? 'fill' : 'click', value: cut(value) });
    }
  }
  const words = [],
    range = document.createRange();
  let length = 0;
  for (const root of roots) {
    const walker = document.createTreeWalker(root === document ? document.body : root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && length < MAX_TEXT) {
      const value = node.textContent.trim(),
        parent = node.parentElement;
      if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
      range.selectNodeContents(node);
      const r = range.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth) {
        words.push(value);
        length += value.length;
      }
    }
  }
  const text = words.join('\n').slice(0, MAX_TEXT),
    height = document.documentElement.scrollHeight;
  const page_key = cache.pageKey(),
    guards = {};
  for (const a of actions) if (!(a.node in guards)) guards[a.node] = cache.hash(cache.guard(cache.nodes.get(a.node)));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics = actions.map(({ rect: _rect, ...action }) => action);
  const marker = [
    performance.timeOrigin,
    location.href,
    scrollX,
    scrollY,
    innerWidth,
    innerHeight,
    document.title,
    text,
    semantics,
    page_key[6],
  ];
  const omitted_actions = Math.max(0, actions.length - 250);
  actions.splice(250);
  return {
    url: location.href.slice(0, 2000),
    title: cut(document.title),
    w: innerWidth,
    h: innerHeight,
    text,
    scroll: { y: scrollY, height },
    actions,
    marker: cache.hash(marker),
    page_key: cache.hash(page_key),
    guards,
    omitted_actions,
  };
})();
