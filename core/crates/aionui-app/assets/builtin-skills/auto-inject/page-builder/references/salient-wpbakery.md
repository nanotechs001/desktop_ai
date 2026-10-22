# Salient theme: Salient WPBakery Page Builder

Salient ships its own rebuild of WPBakery (plugin "Salient WPBakery Page Builder", with "Salient Core"). It adds its own elements (shortcodes mostly prefixed `nectar_…`, plus `fancy_box`, `toggles`, `tabbed_section`, `image_with_animation`, …) and removes stock WPBakery elements it replaces. Elements, their setting names and where each one takes a CSS class: `references/salient-elements.md`.

## Where things live (wp-admin)
- **Page content**: the page's edit screen (Backend Editor, Classic Mode) or the **Frontend Editor** (`/wp-admin/post.php?vc_action=vc_inline&post_id=<ID>&post_type=page`).
- **Per-page theme boxes** under the builder on the edit screen: *Page Header Settings* (header title, subtitle, background image/colour, height, fullscreen, alignment), *Header Navigation* (transparent header for this page, entrance animation), *Page Full Screen Rows*.
- **Salient theme options** (menu *Salient*): site-wide look. See the map below.
- **Global Sections** (menu *Global Sections*): reusable blocks (e.g. "Page Title", "Footer"). Placed in a page with `[nectar_global_section id="…"]`, or site-wide through Salient → Global Sections (After Header Navigation / After Page Content). Editing one changes every page that uses it.
- **WPBakery Page Builder** menu: builder settings, Role Manager, site-wide Custom CSS/JS.

## Frontend Editor (the visual editor; best for changing existing pages)
- Top bar: **+** Add new element, **Salient Templates** (Salient Studio sections), **My Templates**, Undo/Redo, **Element Navigator** (tree of every row/column/element: the fastest way to reach a nested element), responsive preview (desktop/tablet/phone), **Page settings** (page title, page Custom CSS, custom JS), **Update** (saves the page), ⋮ More → Backend Editor / View Page, ✕ exit.
- The page renders inside the iframe `#vc_inline-frame`. Each element is wrapped in an element with `data-tag="<shortcode>"`. Hovering shows its controls (inside the frame):
  - Row: drag, Edit, Change layout (column split), Add new Column, Clone, Copy, Paste, Delete.
  - Column: Edit, Prepend to Column, Append to Column (adds an element), Delete.
  - Element: Edit, Clone, Copy, Delete.
- **Edit** opens the settings panel `#vc_ui-panel-edit-element` in the top document ("<Element> Settings"). Rows have tabs *General | Background | Color Overlay | Shape Divider | Animation*; columns add *Responsive Options* (width per device) and *Border*. Each field wrapper carries `data-vc-shortcode-param-name="<param>"`, the same names as the shortcode attributes. Footer: **Close** (discard) and **Save changes** (applies to the preview only).
- **Add element** panel: search box `#vc_elements_name_filter`, category tabs *All, My Elements, Content, Query, Media, Typography, Structure, Interactive*. Click an element → its settings panel opens → Save changes.
- Nothing is stored until **Update**. Update only when the user asked for the change to be saved.
- While a panel is open (Add Element, an element's settings), the page under it cannot be clicked: `act` answers "covered by the dialog …". Close the panel (Close) or finish it (Save changes) first. To edit an element, hover it and use its own Edit control, or pick it in the Element Navigator.

## Backend Editor / Classic Mode (fastest for building new sections)
- Backend Editor: boxes for rows, columns and elements; the same settings panels.
- Classic Mode: the page as shortcode text. The raw content is also readable without clicking: the `#content` textarea on the edit screen.
- Nesting: `[vc_row …][vc_column width="1/2" …] elements [/vc_column][/vc_row]`; a row inside a column uses `[vc_row_inner][vc_column_inner]…[/vc_column_inner][/vc_row_inner]`. Column widths are fractions (`1/1`, `1/2`, `1/3`, `2/3`, `1/4`, `3/4`, `1/6`, `5/12`, …) that add up to one per row.
- Saved pages list every default attribute (the editor writes them all). When writing new shortcodes, set only the attributes you change; defaults fill the rest.
- **Raw HTML / Raw JS** store content base64-encoded: never hand-edit them as plain text.

## How pages on Salient sites are usually built (seen on a live site)
- First row: `[vc_row type="in_container"][vc_column width="1/1"][nectar_global_section id="…"]` = the shared "Page Title" banner. Keep it.
- Content rows: `type="full_width_background"`, `top_padding="6%" bottom_padding="6%"`, `column_margin="60px"`, `equal_height="yes" content_placement="middle"`; a narrow centred column made with empty `1/6` + `2/3` + `1/6` columns.
- Elements: `vc_column_text` for body text and lists, `nectar_btn` (`button_color_2="Accent-Color"`), `toggles style="minimal"` with `toggle title="…"` holding `vc_column_text`.
- The footer is a Global Section set in theme options, not part of the page.

## Custom classes and CSS (only after the builder's own settings)
1. Put a class on the element you need to target. The field sits in the element's *Advanced* group (end of the *General* tab) and its name differs per element: rows `class` (+ `id` for an anchor), columns `el_class`, inner rows `class`, most elements `el_class`, Call To Action `class`; the table in `references/salient-elements.md` lists them. In shortcode text add e.g. `el_class="kv-cta"`.
2. Write the CSS in **page Custom CSS** (Frontend Editor → Page settings, or the backend "Page settings" gear) when it is for one page. Site-wide CSS (Salient → General Settings → CSS/Script Related → Custom CSS Code, or WPBakery → Custom CSS) changes every page: ask first.
3. Scope every rule to your class (`.kv-cta .nectar-button { … }`). Salient's own rules often use attribute selectors (`div[data-style="minimal"] .toggle …`), so match their specificity rather than reaching for `!important`.

## Salient theme options map (menu Salient; one Save saves all tabs; never save without asking)
- **General Settings**: Styling (theme skin, button style and roundness, column spacing, background and font colour, link style), Functionality (container width and padding, lightbox, animations on mobile, back-to-top), CSS/Script Related (site Custom CSS, custom JS, Google Maps key), Performance, Image Sizes.
- **Accent Colors**: Accent, Extra Color 1–3, two gradients. These feed every `Accent-Color` / `Extra-Color-N` choice in elements; prefer them over hex overrides so a rebrand changes everything at once.
- **Typography**: logo, navigation, page heading; body, H1–H6, bold/italic, labels; Salient elements (Nectar Button, sliders, testimonials, sub-headers); responsive heading sizes.
- **Header Navigation**: logo and general styling (logo upload/height, header padding, shadow, opacity), layout (header layout, full width, header text, social icons), secondary header bar, transparent header, animation effects, dropdown/megamenu, header search, off canvas menu, mobile header (layout, sticky, breakpoint), colour scheme.
- **Global Sections**: After Header Navigation, After Page Content.
- **Footer**: widget area and columns, colours, copyright text and layout, reveal effect, background image, social icons.
- Also: Boxed Layout, Page Transitions, Page Header (auto title header, load-in animation), Form Styling, Call To Action (global CTA bar), Portfolio, Blog, General WordPress Pages (search, 404), Social Media (profile URLs used by every icon set), Home Slider, Demo Importer, Import / Export.

## Fastest: write the whole layout in one script (WordPress REST API)
Clicking WPBakery element by element is slow. Write the page as shortcodes (rows → columns → elements; settings in `references/salient-elements.md`) and send it with one `run_script` you write, from any wp-admin page of the site. A script that changes the site asks the user first: say what it will do.
- The request: `POST /wp-json/wp/v2/pages`, same-origin credentials, headers `X-WP-Nonce` (the value of `wpApiSettings.nonce`, set on every wp-admin page) and `Content-Type: application/json`, JSON body `{ title, status: "draft", content }`. The reply carries the new page's `id` and `link`.
- `content` is the layout as shortcodes, for example: `[vc_row type="full_width_background" top_padding="6%" bottom_padding="6%"][vc_column width="1/2"][vc_column_text]<h1>Title</h1><p>Text</p>[/vc_column_text][nectar_btn text="Get started" url="#" button_color_2="Accent-Color"][/vc_column][vc_column width="1/2"][image_with_animation image_url="123"][/vc_column][/vc_row]`.
- New pages go in as **drafts**; publish only when the user asks.
- To change an existing page: read it first, `GET /wp-json/wp/v2/pages/<id>?context=edit` (`content.raw` is its shortcodes; keep a copy in the chat), then `POST /wp-json/wp/v2/pages/<id>` with the new `content`, only after the user agrees. This saves at once, so it replaces Update.
- Start with the site's usual first row (often the "Page Title" `nectar_global_section`): copy it from an existing page's `content.raw`.
- Images: `image_url` takes a media ID; find one with `GET /wp-json/wp/v2/media?search=<name>`.
- Then open `/wp-admin/post.php?vc_action=vc_inline&post_id=<id>&post_type=page` (Frontend Editor) to check the look and fine-tune. Page Custom CSS is not in the API: set it in Page settings there.
- Never type a long layout into a field with `act` (it takes at most 10,000 characters and the editor changes under it).

## Fast path
1. Check theme options first (accent colours, typography, buttons) and ask before changing anything site-wide.
2. Editing an existing page: open the Frontend Editor, find the element with the Element Navigator, Edit, change fields, Save changes, then Update.
3. New pages or sections: write them as shortcodes and send them in one script (above). Without scripts: start from a **Salient Templates** section close to the target, or paste the shortcodes in Classic Mode in one go, then check in the Backend Editor that every element shows as a box, not as raw text.
4. Style on **rows and columns** first (row type, padding, backgrounds, gradients, shape dividers, column width per device, padding, shadow, radius, animations), then element settings, then a class plus page Custom CSS.
5. To learn an element's settings, read them from the editor instead of guessing: on the edit screen, `vc.map['<tag>'].params` lists every setting (`param_name`, `type`, `heading`, `value`, `group`).
6. Save with **Update** (or Save Draft); publish only when the user asks.
