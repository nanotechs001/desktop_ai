/*
 * Frame snapshot for the aion-browser `observe` tool. Evaluated as one expression in our own isolated world of
 * each frame, so the page can neither read nor forge window.__aionFast.
 *
 * Ported from jev-ultrafast (https://github.com/browser-use/jev-ultrafast, jev_ultrafast/snapshot.js).
 * Changes: walks open shadow roots; reports every contenteditable (and a designMode body) as textbox, and
 * other draggable="true" elements (builder widgets, sortable items) as draggable, for the drag tool; one
 * entry per element (a select lists its options instead of one action per option; no "Open" duplicates,
 * no scroll/wait pseudo-actions); state lives in window.__aionFast; the page key and guards are returned
 * as short hashes, and page strings are cut (labels, values and options to 200 chars, 50 options per select,
 * 6000 chars of text) so a 250-row snapshot stays small; aria states are kept only as true/false/mixed.
 * Rects stay frame-local, as in jev. Also: an unnamed control gets a guessed name (tooltip, id, icon class or its
 * place); builder-canvas elements (plain divs that are clickable or carry builder hints) are listed too, at most 60;
 * builder items marked as GoHighLevel marks them (class c-<type>, id <type>-<hash>) by type and place, like
 * image "image 3 · column 3 · row 2", and act clicks them where the click selects the item itself;
 * the page key is only the document and url; guards hold what makes a control that control (no node identity, no
 * surrounding text except a dialog's or a row's), so an equivalent node that replaced it is re-found where it was;
 * a new node that is the same control as a gone one keeps its id. For act's change list and observe's load wait it also
 * reports open dialogs and menus, a cross-document navigation the page started, the ready state, and whether the DOM
 * or the network moved in the last half second.
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
  /** Guessed names and canvas element names stay short. */
  const MAX_GUESS = 60;
  /** Canvas elements (clickable divs, builder hints) listed per frame, after the real controls. */
  const MAX_EXTRA = 60;
  /** How far (document CSS px, each axis) an equivalent control may sit from where it was to count as the same. */
  const NEAR_PX = 32;
  /** Gone controls whose identity stays known (a hover-only toolbar comes back under its old ids); oldest go first. */
  const MAX_GONE = 200;
  const cut = (text) => String(text).slice(0, MAX_STRING);
  const cache = (window.__aionFast ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  // id -> {role, label, at, owner}: what a snapshot last saw under that id, at its center in document px, and the DOM
  // id of the builder item it sits in ('' for none).
  cache.seen ||= new Map();
  cache.center = (e) => {
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2 + scrollX, r.y + r.height / 2 + scrollY];
  };
  cache.near = (a, b) => Math.abs(a[0] - b[0]) <= NEAR_PX && Math.abs(a[1] - b[1]) <= NEAR_PX;
  /**
   * An element keeps its id; a new node that is the same control as a gone one (role, label, owner item, place) takes
   * its id.
   */
  const identity = (e, role, label, at) => {
    let id = cache.ids.get(e);
    const owner = ownerId(e);
    if (id === undefined) {
      for (const [old, seen] of cache.seen) {
        if (cache.nodes.has(old) || seen.role !== role || seen.label !== label || seen.owner !== owner) continue;
        if (!cache.near(seen.at, at)) continue;
        id = old;
        break;
      }
      id ??= cache.next++;
      cache.ids.set(e, id);
    }
    cache.nodes.set(id, e);
    cache.seen.set(id, { role, label, at, owner });
    return id;
  };
  for (const [id, e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  /** The DOM or the network moved this recently (ms): the document is busy. */
  const BUSY_MS = 500;
  if (!cache.observer) {
    // First sight: no history yet, so the document counts as busy until the next look.
    cache.changedAt = performance.now();
    cache.observer = new MutationObserver(() => (cache.changedAt = performance.now()));
    cache.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    // A click on a link starts a navigation before the old document goes: act reports it once.
    window.navigation?.addEventListener('navigate', (e) => {
      if (!e.destination.sameDocument && !e.downloadRequest) cache.navigating = e.destination.url;
    });
  }
  const loadedAt = performance
    .getEntriesByType('resource')
    .slice(-20)
    .reduce((last, entry) => Math.max(last, entry.responseEnd), 0);
  const busy = performance.now() - Math.max(cache.changedAt, loadedAt) < BUSY_MS;
  const navigating = cache.navigating || '';
  cache.navigating = '';
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
  // Builder hints: a data-* name or a class with one of these words (whole words, so "color" is not "col").
  const KINDS = new Map([
    ['section', 'section'],
    ['row', 'row'],
    ['col', 'column'],
    ['column', 'column'],
    ['block', 'block'],
    ['widget', 'widget'],
    ['element', 'element'],
    ['el', 'element'],
  ]);
  const kindOf = (text, isData) => {
    const words = text.toLowerCase().split(/[^a-z0-9]+/);
    if (isData && words.some((w) => w === 'test' || w === 'qa' || w === 'cy')) return null; // test ids
    const kind = words.map((w) => KINDS.get(w)).find(Boolean);
    return kind || (isData && words.includes('id') ? 'element' : null);
  };
  /**
   * A builder item's type: a class c-<type> with an id <type>-<hash> (col-<hash> for a column), as GoHighLevel marks
   * its sections, rows, columns and elements. Null for anything else.
   */
  const builderType = (e) => {
    const id = e.id;
    if (!id) return null;
    for (const c of e.classList) {
      const type = c.startsWith('c-') && c.slice(2);
      if (type && (id.startsWith(type + '-') || (type === 'column' && id.startsWith('col-')))) return type;
    }
    return null;
  };
  /** The nearest builder item above `e`, null when there is none. */
  const itemAbove = (e) => {
    let p = e.parentElement;
    while (p && !builderType(p)) p = p.parentElement;
    return p;
  };
  const itemAt = (e) => (builderType(e) ? e : itemAbove(e));
  /** The DOM id of the builder item a control (not an item itself) sits in, such as a toolbar icon's element; ''. */
  const ownerId = (e) => (builderType(e) ? '' : itemAbove(e)?.id || '');
  /**
   * The builder item that shows control `e` (seen as `seen`), which may show it only while hovered: `e`'s item, or
   * while `e` is gone the item it was last seen in. Null for none.
   */
  cache.ownerOf = (e, seen) => {
    if (e?.isConnected) return builderType(e) ? null : itemAbove(e);
    // shortcut: an item inside a shadow root is not found by id; GoHighLevel's are in the document.
    const item = seen?.owner ? document.getElementById(seen.owner) : null;
    return item && builderType(item) ? item : null;
  };
  /** The builder items of `x`'s type whose nearest item above is the same as `x`'s, `x` too, in document order. */
  const siblingItems = (x) => {
    const [parent, type] = [itemAbove(x), builderType(x)];
    const root = parent || x.getRootNode();
    // Memo for one synchronous run (a snapshot, or one act check): the page may change between runs.
    if (!cache.memo) {
      cache.memo = new Map();
      queueMicrotask(() => (cache.memo = null));
    }
    if (!cache.memo.has(root)) cache.memo.set(root, new Map());
    const types = cache.memo.get(root);
    if (!types.has(type)) {
      const all = root.querySelectorAll('.c-' + CSS.escape(type));
      types.set(
        type,
        [...all].filter((y) => builderType(y) === type && itemAbove(y) === parent)
      );
    }
    return types.get(type);
  };
  // Image alts that name nothing: placeholders while loading or broken, and file names.
  const PLACEHOLDER_ALT = /^(loading\b|broken image)|\.[a-z0-9]{2,5}$/i;
  const NO_TEXT = /^(STYLE|SCRIPT|NOSCRIPT|TEMPLATE)$/;
  /** A builder item's own visible text and meaningful image alts, not those of the items inside it. */
  const ownText = (e) => {
    const walker = document.createTreeWalker(e, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType === 3) return visible(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        if ((n !== e && builderType(n)) || NO_TEXT.test(n.tagName)) return NodeFilter.FILTER_REJECT;
        const alt = n.tagName === 'IMG' && n.getAttribute('alt')?.trim();
        return alt && !PLACEHOLDER_ALT.test(alt) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let text = '';
    for (let n = walker.nextNode(); n && text.length < MAX_GUESS; n = walker.nextNode()) {
      text += ' ' + (n.nodeType === 3 ? n.textContent : n.getAttribute('alt'));
    }
    return text.replace(/\s+/g, ' ').trim();
  };
  const isSelected = (e) =>
    e.getAttribute('aria-selected') === 'true' ||
    !['false', null].includes(e.getAttribute('aria-current')) ||
    e.classList.contains('selected') ||
    [...e.querySelectorAll('.selected')].some((x) => itemAt(x) === e);
  /**
   * A builder item by type and place, like "image 3 · column 3 · row 2": its ordinal among same-type siblings, then
   * each item above it, the section only when there are several; then its own text, and "(selected)".
   */
  const builderName = (e) => {
    const parts = [];
    let top = e;
    for (let x = e; x; x = itemAbove(x)) {
      parts.push(builderType(x) + ' ' + (siblingItems(x).indexOf(x) + 1));
      top = x;
    }
    if (parts.length > 1 && siblingItems(top).length < 2) parts.pop();
    const selected = isSelected(e) ? ' (selected)' : '';
    const named = [parts.join(' · '), explicitName(e) || ownText(e)].filter(Boolean).join(' · ');
    return named.slice(0, MAX_GUESS - selected.length) + selected;
  };
  /**
   * The role of a canvas element: clickable but not a control (a data-* builder hint, onclick, tabindex >= 0, or a
   * builder class with a pointer cursor). `styled` false skips the computed style, to pick candidates cheaply.
   */
  const hintRole = (e, styled = true) => {
    const type = builderType(e);
    if (type) return type;
    for (const a of e.attributes) {
      const kind = a.name.startsWith('data-') && kindOf(a.name.slice(5), true);
      if (kind) return kind;
    }
    if (e.hasAttribute('onclick') || (e.hasAttribute('tabindex') && e.tabIndex >= 0)) return 'clickable';
    const kind = kindOf(e.getAttribute('class') || '', false);
    return kind && (!styled || getComputedStyle(e).cursor === 'pointer') ? kind : null;
  };
  // The document plus every open shadow root under it (closed roots are unreachable by design), and in the same
  // pass the elements with a builder hint (canvas candidates).
  const rootsAndHinted = () => {
    const found = { roots: [], hinted: [] };
    const addRoot = (root) => {
      found.roots.push(root);
      for (const e of root.querySelectorAll('*')) {
        if (hintRole(e, false)) found.hinted.push(e);
        if (e.shadowRoot) addRoot(e.shadowRoot);
      }
    };
    addRoot(document);
    return found;
  };
  const { roots, hinted } = rootsAndHinted();
  const all = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
  const safe = (e) => !['password', 'file', 'hidden'].includes(e.type);
  const visible = (e) =>
    !e.closest('[aria-hidden="true"],[inert]') && e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  // Material icon fonts spell the icon as text ("add"); that text is an icon name, not a label.
  const isLigature = (e) => /\bmaterial-(icons|symbols)/.test(e.getAttribute('class') || '');
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
                : n.nodeType === 1 &&
                    n.getAttribute('aria-hidden') !== 'true' &&
                    !isLigature(n) &&
                    !NO_TEXT.test(n.tagName)
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
    return hintRole(e);
  };
  const TOOLTIPS = ['data-tooltip', 'data-original-title', 'data-title', 'data-tip', 'tooltip'];
  // Words that say nothing about what an icon or id does.
  const NOISE = new Set(
    (
      'btn button icon icons ico svg img fa fas far fal fab fad solid regular light thin duotone brands sharp fw lg ' +
      'sm xs xl line fill filled outline outlined round rounded mdi ri bi material symbols el js wrapper container'
    ).split(' ')
  );
  const words = (text) =>
    text
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !NOISE.has(w) && !/\d/.test(w))
      .slice(0, 4)
      .join(' ');
  const ICON = /^(?:fa|mdi|icon|ri|bi)-(.+)$/;
  /** An icon name from an icon-font class, a ligature or an svg sprite, on the control or inside it. */
  const iconOf = (e) => {
    for (const x of [e, ...[...e.querySelectorAll('[class],use')].slice(0, 20)]) {
      const cls = x.getAttribute('class') || '';
      if (isLigature(x) && words(x.textContent)) return words(x.textContent);
      for (const c of cls.split(/\s+/)) {
        const icon = ICON.exec(c);
        if (icon && words(icon[1])) return words(icon[1]);
      }
      const sprite = x.tagName === 'use' && /#(.+)$/.exec(x.getAttribute('href') || x.getAttribute('xlink:href') || '');
      if (sprite && words(sprite[1])) return words(sprite[1]);
    }
    return '';
  };
  const attrText = (e, keys) =>
    keys
      .map((key) => e.getAttribute(key))
      .find((v) => v && v.trim())
      ?.trim() || '';
  /** An explicit name: aria-labelledby, aria-label, title, a tooltip attribute, or the text aria-describedby names. */
  const explicitName = (e) =>
    (e.getAttribute('aria-labelledby') && name(e)) ||
    attrText(e, ['aria-label', 'title', ...TOOLTIPS]) ||
    (e.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .map((id) => e.getRootNode().getElementById?.(id)?.textContent.trim())
      .filter(Boolean)
      .join(' ');
  /** A name for a control without one: a tooltip, else marked guesses from its test id, name or id, or its icon. */
  const guessed = (e) => {
    const tip = explicitName(e);
    const id = !tip && words(attrText(e, ['data-testid', 'data-test', 'data-qa', 'name', 'id']));
    const icon = !tip && !id && iconOf(e);
    return (tip || (id && '(id: ' + id + ')') || (icon && '(icon: ' + icon + ')') || '').slice(0, MAX_GUESS);
  };
  /** What the control is called: a canvas element by its explicit name or text, a control by its name or a guess. */
  const label = (e, r) =>
    (builderType(e)
      ? builderName(e)
      : roles.includes(r) || !hintRole(e, false)
        ? name(e) || guessed(e)
        : explicitName(e) || name(e)
    ).slice(0, MAX_STRING);
  const PLACES =
    '[role="toolbar"],[role="menubar"],[role="menu"],[role="tablist"],[role="group"],header,nav,aside,footer,form';
  const places = new Map();
  /** Last resort for a control with no name at all: its kind and place, like "icon button 3 in toolbar". */
  const place = (e, r) => {
    const box = e.parentElement?.closest(PLACES) || e.getRootNode();
    const where = box.nodeType === 1 ? box.getAttribute('role') || box.tagName.toLowerCase() : 'page';
    if (!places.has(box)) places.set(box, [...box.querySelectorAll(selector)]);
    const n = places.get(box).indexOf(e) + 1;
    const icon = e.querySelector('svg,img,i,[class*="icon"]') ? 'icon ' : '';
    return '(' + icon + r + (n ? ' ' + n : '') + ' in ' + where + ')';
  };
  // Only a new document or url makes every id of the frame stale; anything else is checked per target.
  cache.pageKey = () => [performance.timeOrigin, location.href];
  // What makes a control that control: role, name, state, and the dialog or row it acts on (a Delete button means
  // the row it is in, a toolbar icon the builder item it is in). Not its node, so an equivalent node that replaced it is
  // the same control.
  cache.guard = (e) => {
    if (!e?.isConnected || !visible(e)) return null;
    const r = role(e);
    const scope = e.closest('dialog,[role="dialog"],[role="alertdialog"],article,li,tr,[role="row"]');
    return [
      r,
      label(e, r),
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
      ownerId(e),
    ];
  };
  /** Every element that may be a control: for re-finding one whose node was replaced. */
  cache.collect = () => {
    const now = rootsAndHinted();
    return [...now.roots.flatMap((root) => [...root.querySelectorAll(selector)]), ...now.hinted];
  };
  /**
   * The element now showing the control observed as `node` (seen there as `seen`): the nearest one, with no id of its
   * own, of the same role where it was whose guard `fresh` accepts. It takes over the id. Null when there is none.
   */
  cache.refind = (node, seen, fresh) => {
    let best = null;
    let distance = Infinity;
    for (const x of new Set(cache.collect())) {
      if ((cache.ids.has(x) && cache.ids.get(x) !== node) || role(x) !== seen.role) continue;
      const at = cache.center(x);
      const d = Math.hypot(at[0] - seen.at[0], at[1] - seen.at[1]);
      if (d < distance && cache.near(at, seen.at) && fresh(x)) [best, distance] = [x, d];
    }
    if (best) {
      cache.ids.set(best, node);
      cache.nodes.set(node, best);
    }
    return best;
  };
  // A designMode document (a rich-text iframe) is one big textbox with no contenteditable attribute.
  const candidates = new Set(all(selector));
  if (document.body.isContentEditable) candidates.add(document.body);
  const actions = [];
  const inView = (r) => {
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    return r.width > 0 && r.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  };
  const shows = (r) =>
    r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.x < innerWidth && r.y < innerHeight;
  /**
   * Where a click selects `e` itself (frame-local): its center, or for a builder item the first of a few points of its
   * visible part whose nearest item is `e` (a column's padding, not the image in it).
   */
  cache.pointIn = (e) => {
    const r = e.getBoundingClientRect();
    const center = [r.x + r.width / 2, r.y + r.height / 2];
    if (!builderType(e)) return center;
    const [left, top] = [Math.max(r.left, 0), Math.max(r.top, 0)];
    const [right, bottom] = [Math.min(r.right, innerWidth), Math.min(r.bottom, innerHeight)];
    for (const y of [(top + bottom) / 2, top + 3, bottom - 3]) {
      for (const x of [(left + right) / 2, left + 3, right - 3]) {
        const hit = document.elementFromPoint(x, y);
        if (hit && itemAt(hit) === e) return [x, y];
      }
    }
    return center;
  };
  const rectOf = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
  const at = (r) => [r.x + r.width / 2 + scrollX, r.y + r.height / 2 + scrollY];
  for (const e of candidates) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r = e.getBoundingClientRect(),
      rname = role(e);
    if (!rname || !inView(r)) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const named = cut(label(e, rname) || place(e, rname));
    const base = { node: identity(e, rname, named, at(r)), role: rname, label: named, rect: rectOf(r) };
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
  // Who owns each visible text node: its nearest control or canvas element (for "has its own text" below).
  const hintedSet = new Set(hinted);
  const roleOf = new Map();
  const ownsText = (p) => {
    if (candidates.has(p)) return true;
    if (!hintedSet.has(p)) return false;
    if (!roleOf.has(p)) roleOf.set(p, hintRole(p));
    return Boolean(roleOf.get(p));
  };
  const owned = new Set();
  const lines = [],
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
        lines.push(value);
        length += value.length;
        // shortcut: only text within the first MAX_TEXT chars marks its owner; a canvas past that needs scope.
        for (let p = parent; p; p = p.parentElement) {
          if (!ownsText(p)) continue;
          owned.add(p);
          break;
        }
      }
    }
  }
  // Canvas elements: hinted, visible, centered in the viewport, not a control or inside one, smaller than half the
  // viewport (a page wrapper is not something to select). Of nested ones the outermost, plus inner ones with their
  // own name or text; a wrapper exactly around a control is that control. Builder items (any size, partly in view)
  // and focusable role="group" wrappers are always listed.
  const kept = new Set();
  let extra = 0;
  for (const e of hinted) {
    if (extra >= MAX_EXTRA) break;
    const r = e.getBoundingClientRect();
    const item = Boolean(builderType(e));
    if (item ? !shows(r) : !inView(r) || r.width * r.height * 2 > innerWidth * innerHeight) continue;
    if (e.closest(selector)) continue;
    const kind = roleOf.get(e) ?? hintRole(e);
    if (!kind || !visible(e)) continue;
    let outer = e.parentElement;
    while (outer && !kept.has(outer)) outer = outer.parentElement;
    const always = item || (e.getAttribute('role') === 'group' && e.tabIndex >= 0);
    if (outer && !always && !owned.has(e) && !explicitName(e)) continue;
    const inner = !item && e.querySelector(selector)?.getBoundingClientRect();
    if (
      inner &&
      [r.x - inner.x, r.y - inner.y, r.right - inner.right, r.bottom - inner.bottom].every((d) => Math.abs(d) <= 4)
    ) {
      continue;
    }
    const named = cut(label(e, kind).slice(0, MAX_GUESS) || place(e, kind));
    kept.add(e);
    extra++;
    actions.push({
      node: identity(e, kind, named, at(r)),
      role: kind,
      label: named,
      rect: rectOf(r),
      kind: 'click',
      value: '',
    });
  }
  const gone = [...cache.seen.keys()].filter((id) => !cache.nodes.has(id));
  for (const id of gone.slice(0, Math.max(0, gone.length - MAX_GONE))) cache.seen.delete(id);
  // Open dialogs and menus, as act reports one that a step opened.
  const dialogs = all(
    'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="menu"],[role="listbox"]'
  )
    .filter((e) => visible(e) && inView(e.getBoundingClientRect()))
    .slice(0, 10)
    .map((e) => ({
      role: e.getAttribute('role') || 'dialog',
      label: (explicitName(e) || e.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')?.textContent.trim() || '').slice(
        0,
        MAX_GUESS
      ),
    }));
  const text = lines.join('\n').slice(0, MAX_TEXT),
    height = document.documentElement.scrollHeight;
  const page_key = cache.pageKey(),
    guards = {};
  for (const a of actions) if (!(a.node in guards)) guards[a.node] = cache.hash(cache.guard(cache.nodes.get(a.node)));
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
    page_key: cache.hash(page_key),
    guards,
    omitted_actions,
    ready: document.readyState,
    busy,
    navigating: navigating.slice(0, 2000),
    dialogs,
  };
})();
