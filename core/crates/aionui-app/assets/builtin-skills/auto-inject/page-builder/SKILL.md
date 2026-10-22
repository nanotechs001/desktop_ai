---
name: page-builder
description: >-
  Build or restyle a page fast in a visual page builder (GoHighLevel, Elementor, WordPress block editor, others): plan first, use the builder's own features before CSS.
---

# Page builder

Goal: finish the page in as few browser steps as possible, using the builder's own features first.

## 1. Identify the builder (one observe)
| Signs | Builder | Read |
|---|---|---|
| `app.gohighlevel.com` or a white-label app, URL with `page-builder` / `funnel`, frame `funnel-builder` | GoHighLevel | `references/ghl.md` |
| `wp-admin/post.php?…&action=elementor`, panel "Elements / Globals", `elementor-` classes | Elementor | `references/elementor.md` |
| `wp-admin/post.php` / `post-new.php` or the Site Editor, block inserter "+", "Patterns" | WordPress block editor (Gutenberg) | `references/gutenberg.md` |
| anything else | unknown builder | section 2 |

Then check your notebook for lessons about this builder before you start.

## 2. Unknown builder: explore once, briefly
Map it before building (a few observes, no edits):
- how to **add** things (insert panel, "+", drag sources) and the **structure** levels (section → row/column → element);
- where an element's **settings** open and its tabs (content / style / advanced), and whether there are **global styles** (site colors, fonts, theme styles);
- **templates, patterns or saved sections**, **duplicate**, **copy/paste style**, the **layers/navigator** view, **responsive** toggles, **undo**, **save/preview/publish**.
Try one small change and undo it to learn how it saves. Save what you learned with `aionui-notes.add` (one note per builder).

## 3. Plan the whole page first
Write the outline as one list (sections → rows/columns → elements with their text) and the style system (2–3 colors, heading/body fonts, spacing). Then build top-down. Do not explore while building.

## 4. Build fast
- Start from a **template / pattern / saved section** close to the target when one exists.
- Build one section completely, then **duplicate** it for similar sections and edit only the text.
- Chain steps in **one `act` call** (several actions) and read its result: it lists what changed and the new ids. Observe again only when you need the whole page, after navigation, or when act says so.
- Type text into the element's own field or settings panel in one pass per element.
- Avoid screenshots while building; take one per finished section to check the look.

## 5. Style with the builder first, CSS last
Use, in this order, and move down only when the level above cannot do it:
1. **Global / site styles** (theme colors, fonts, buttons): set once, everything inherits.
2. **The element's own style controls** (typography, colors, spacing, borders, background, alignment, responsive values).
3. **Copy/paste style** between elements, or a saved/global element.
4. The builder's **custom CSS / CSS class field** for that element.
5. **Page-level custom CSS** (one block, scoped with classes you added).
6. A **custom HTML/code element** only for something the builder truly cannot make, and only if the user allows code.
Never rebuild a whole design in CSS when the builder's controls can do it: users must be able to edit it later in the builder.

## 6. Finish
Save (or autosave) after each section. Preview to check desktop and mobile. Publish only when the user asked. Then save one or two lessons: the fastest steps that worked in this builder and what to avoid.
