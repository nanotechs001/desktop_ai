# WordPress block editor (Gutenberg)

## Where things are
- Insert blocks with the **+** inserter, or type **/** plus a block name in an empty paragraph (fastest).
- **Patterns** (in the inserter) give ready-made sections; synced patterns are reusable across pages.
- Layout blocks: Group, Row, Stack, Columns, Cover, Spacer.
- The right sidebar has the block's **Settings** and **Styles** (color, typography, dimensions); **Advanced** holds HTML anchor and **Additional CSS class(es)**.
- **List View** (the tree) selects nested blocks quickly.
- Block themes: the **Site Editor → Styles** sets global colors, fonts and per-block styles, and has **Additional CSS** for the site.
- The **Code editor** (editor menu ⋮ → Code editor) shows the post as block markup.

## Fast path
1. Set global styles in Site Editor → Styles when the theme is a block theme.
2. Insert patterns close to the target; or build one Group/Columns section and duplicate it (block toolbar ⋮ → Duplicate).
3. For a whole page, writing valid block markup in the Code editor in one paste is often fastest, but only with standard core blocks, and switch back to the visual editor to check it parses (no "block contains unexpected content" warnings).
4. Style with block Styles and global styles first; then an Additional CSS class plus site Additional CSS.
5. Save draft / Update; publish only when the user asks.
