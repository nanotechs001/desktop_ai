# Elementor (WordPress)

## Where things are
- Left panel: **Elements** (widgets) and **Globals**; the gear/site menu has **Site Settings** (global colors, global fonts, typography, buttons, layout).
- Structure: **Containers** (flexbox/grid) in current Elementor; older sites use Section → Column → Widget.
- A selected widget's panel has **Content / Style / Advanced** tabs. Advanced holds margin/padding, width, CSS ID and classes, responsive visibility, and **Custom CSS** (Elementor Pro only).
- **Navigator** (layers) shows the tree; the folder icon opens the **template library**; **Page Settings** (gear at the bottom left) holds the page title, status and **Page Layout** (Default, Elementor Canvas, Full Width).
- The page renders in the **Preview** iframe; observe lists its parts as `draggable "Edit Heading …"`, so it shows what is on the canvas.

## Fastest: build with Elementor's own command API (how a fast run did it)
A whole page was built and restyled in about 20 steps, with no clicking in the panels, by running scripts in the editor tab that call the same commands the editor runs when you click. Everything stays editable in the normal panels, Undo works, and nothing goes live until it is saved. Write each script yourself for the user's request; every one that changes the page asks the user first, so do the work in a few large scripts, not many small ones.

1. **Wait for the editor.** Open `wp-admin/post.php?post=<id>&action=elementor` and observe until the "Add Element" button shows. A script run while it loads fails (the preview container is undefined); if the tab closed, open the URL again and wait.
2. **Scripts:** `run_script` with `mode: "write"`, `world: "page"` (the page world sees Elementor's globals; read mode cannot) and `form: "body"` (the code is a function body). End with `return` of a short value (a count, "ok") to confirm it ran. There is no `ELEMENTOR_VERSION` global.
3. **Check containers once:** `elementorCommon.config.experimentalFeatures.container` true means flexbox Containers; else build Sections and Columns.
4. **Build the whole skeleton in one script.** The root is `elementor.getPreviewContainer()`. Add each element with `$e.run('document/elements/create', { container: <parent>, model, options: { edit: false } })`; it returns the new element, which is the parent for its children. Models:
   - container: `{ elType: 'container', settings: {…} }`
   - widget: `{ elType: 'widget', widgetType: '<type>', settings: {…} }`, types such as `heading`, `text-editor`, `button`, `image`, `image-box`, `icon-box`, `icon-list`, `divider`, `form` (Pro), `social-icons`.
   - Build top to bottom: one container per section, row containers inside for columns, widgets inside those.
5. **Look, then fix in batches.** Take a screenshot. To change elements, walk the tree from the root (each element has `children`; its type is `model.get('widgetType')` or `model.get('elType')`), pick them by type, and call `$e.run('document/elements/settings', { container: <element>, settings: {…} })`. To remove one: `$e.run('document/elements/delete', { container: <element> })`; to start over, delete every child of the root.
6. **Save** with `$e.run('document/save/draft')` and do not await it (awaiting runs past the 10-second script limit); the next screenshot shows it saved. Publish only when the user asks.
7. **Page Layout** (Canvas hides the theme header and footer): set it in Page Settings with `act` (select "Elementor Canvas" in the "Page Layout" dropdown), never by script; changing it by script reloaded and hung the editor.
8. Before building a nav or footer, check whether the theme already shows one (a screenshot); build them only with the Canvas layout.

## Setting keys (the same names the panels save)
- Container: `flex_direction` (`row` | `column`), `flex_justify_content` (`flex-start` | `center` | `space-between` | `flex-end`), `flex_align_items`, `flex_gap: { unit: 'px', size: 20, column: '20', row: '20' }`, `content_width: 'full'`, `width: { unit: '%', size: 50 }` (+ `width_mobile`), `min_height: { unit: 'vh', size: 70 }`, `padding: { unit: 'px', top, right, bottom, left, isLinked: false }`, background `background_background: 'classic'` + `background_color`.
- Widget text: heading `title`, `header_size` (`h1`…`h6`), `align`; text-editor `editor` (HTML); button `text`, `align`; image-box `title_text`, `description_text`; icon-box `selected_icon: { value: 'fas fa-paper-plane', library: 'fa-solid' }`, `title_text`.
- Colors: heading `title_color`; text-editor `text_color`; button `background_color`, `button_text_color`; image-box and icon-box `title_color`, `description_color`, icon `primary_color`; form `button_background_color`, `button_text_color`, `field_text_color`, `field_background_color`, `field_border_color`.
- Typography: `<prefix>typography_typography: 'custom'`, then `<prefix>typography_font_family` ('Montserrat'), `…_font_weight` (a string, '400'), `…_font_size: { unit: 'px', size }`, `…_line_height: { unit: 'em', size }`, `…_letter_spacing: { unit: 'px', size }`, `typography_text_transform: 'uppercase'`. The prefix is '' for heading, text-editor and button; `title_` / `description_` for image-box and icon-box; `field_` / `button_` for the form; `icon_` for icon-list items. A wrong prefix silently does nothing: check the result in a screenshot.
- Size and place a widget: `_element_width: 'initial'` with `_element_custom_width: { unit: 'px', size: 480 }` (+ `_element_width_mobile`, `_element_custom_width_mobile: { unit: '%', size: 100 }`); `_flex_align_self: 'center'` centers it in a column container. Image: `width: { unit: 'px', size }`, `image_border_radius` (`{ unit: '%', top: 50, … }` for round), `object_fit: 'cover'`. Corners: `border_radius` / `button_border_radius`; padding `text_padding`.
- Form (Pro): `form_fields` is an array (read it with `settings.get('form_fields').toJSON()`, change, set back), field `width` ('66'), `button_width` ('33'), `column_gap`, `row_gap`.

## Without scripts (the user refused them)
1. Set **Site Settings → global colors and fonts** first; pick them in widgets instead of raw values.
2. Insert a template block close to the target, or build one container and **duplicate** it (right-click → Duplicate, or Ctrl/Cmd+D).
3. Use right-click **Copy / Paste Style** to repeat a widget's look.
4. Use the Navigator to select nested items instead of hunting on the canvas.
5. Only then: a CSS class plus Custom CSS (Pro), or the theme's Additional CSS.
6. Click **Update/Publish** to save (Elementor does not autosave to the live page).

## Never
- Custom CSS for what a widget's own controls can set.
- Leave the editor with unsaved work: closing the tab loses it.
