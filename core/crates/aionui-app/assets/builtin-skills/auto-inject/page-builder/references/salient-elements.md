# Salient WPBakery elements

Read from a live Salient site's element registry. The registry on the user's site is the source of truth: on a page edit screen, `vc.map['<tag>']` holds `name`, `category` and `params` (`param_name`, `type`, `heading`, `value`, `group`). Check it when an element or setting below is missing.

## Elements by category (shortcode — name)
- **Structure**: `vc_row` Row, `vc_row_inner` Inner Row, `vc_column` / `vc_column_inner` Column, `divider` Divider (spacing or line), `page_submenu` Page Submenu, `vc_widget_sidebar` Sidebar, `vc_raw_html` Raw HTML, `vc_raw_js` Raw JS.
- **Content**: `vc_column_text` Text Block, `vc_custom_heading` Custom Heading, `nectar_icon` Icon, `nectar_icon_list` (+ `nectar_icon_list_item`) Icon List, `text-with-icon` Text With Icon, `fancy-ul` Fancy List, `fancy_box` Fancy Box, `team_member`, `milestone` (animated number), `bar` Progress Bar, `pricing_table`, `clients`, `social_buttons`, `nectar_single_testimonial`, `nectar_star_rating`, `nectar_lottie`, `nectar_animated_shape`, `nectar_horizontal_list_item`, `nectar_food_menu_item`, `morphing_outline`, `nectar_sticky_media_sections`, `vc_gallery`, `vc_video`, `vc_pie`, `vc_text_separator`, `vc_zigzag`, `vc_wp_custommenu`, `vc_gutenberg`, `gravityform` Gravity Form.
- **Typography**: `split_line_heading` Split Line Heading, `heading` Centered Heading, `nectar_highlighted_text`, `nectar_gradient_text`, `nectar_animated_title`, `nectar_rotating_words_title`, `nectar_scrolling_text`, `nectar_text_inline_images`, `nectar_responsive_text`, `nectar_badge`, `nectar_price_typography`.
- **Media**: `image_with_animation` Single Image, `nectar_slider` Nectar Slider, `nectar_cascading_images`, `nectar_image_comparison`, `nectar_video_lightbox`, `nectar_video_player_self_hosted`, `nectar_circle_images`.
- **Interactive**: `nectar_btn` Button, `nectar_cta` Call To Action, `toggles` (+ `toggle`) accordion, `tabbed_section` (+ `tab`) Tabs, `testimonial_slider` (+ `testimonial`), `carousel` (+ `item`), `nectar_flip_box`, `nectar_image_with_hotspots`, `nectar_gmap` Map.
- **Query**: `nectar_global_section` Global Section, `nectar_post_grid` Post Loop Builder, `nectar_blog`, `recent_posts`, `nectar_portfolio`, `recent_projects`, `nectar_category_grid`.

## Where each element takes a CSS class / ID
| Element | Class field | ID field |
| --- | --- | --- |
| `vc_row` | `class` | `id` (also `row_name` for the navigator) |
| `vc_row_inner` | `class` | `el_id` |
| `vc_column`, `vc_column_inner` | `el_class` | none |
| `vc_column_text`, `vc_custom_heading`, `vc_raw_html` | `el_class` | `el_id` |
| `nectar_btn` | `el_class` | `button_id` |
| `nectar_cta` | `class` | none |
| `image_with_animation`, `split_line_heading`, `tab`, `tabbed_section` | `el_class` | none |
| `nectar_highlighted_text` | none | `id` |
| `fancy_box`, `toggles`, `toggle`, `nectar_icon`, `nectar_icon_list`, `divider`, `testimonial_slider` | none: put the class on the parent column (`el_class`) and target the element inside it | none |

## Key settings (desktop names; most spacing/position settings also have `_tablet` / `_phone` versions)
- **vc_row**: `type` [in_container|full_width_background|full_width_content], `full_height`, `equal_height`, `content_placement` [top|middle|bottom], `column_margin` [default|5px…|none], `top_padding`, `bottom_padding`, `left_padding_desktop`, `right_padding_desktop`, `top_margin`, `bottom_margin`, `text_color` [dark|light|custom] + `custom_text_color`, `text_align`, `row_border_radius`, `sticky_row`, `overflow`, `class`, `id`, `disable_element`. Background tab: `bg_color`, `bg_image`, `bg_position`, `bg_repeat`, `parallax_bg`, `video_bg`, `animated_gradient_bg`. Color Overlay tab: `enable_gradient`, `color_overlay`, `color_overlay_2`, `overlay_strength`, `gradient_direction`. Shape Divider tab: `enable_shape_divider`, `shape_type`, `shape_divider_color`, `shape_divider_position`, `shape_divider_height`. Animation tab: `bg_image_animation`.
- **vc_column**: `width` (Responsive Options tab) + `offset` for other devices, `column_padding` [no-extra-padding|padding-1-percent…] or `top_padding_desktop`…, `column_padding_position`, `centered_text`, `desktop_text_alignment`, `font_color`, `column_element_direction_desktop` [default|horizontal], `column_element_spacing`, `max_width_desktop`, `column_shadow`, `column_border_radius`, `column_link`, `el_class`. Background: `background_color` (+ `_opacity`, `_hover`), `background_image`, `column_backdrop_filter`, `mask_enable`. Animation: `enable_animation`, `animation` [fade-in|fade-in-from-bottom|…], `delay`. Border: `column_border_width`, `column_border_color`, `column_border_style`.
- **vc_column_text**: content (HTML), `max_width`, `css_animation`, `css` (Design Options: padding/margin/border/background), `el_class`, `el_id`.
- **vc_custom_heading**: `text`, `font_container` (tag, size, colour, alignment), `use_theme_fonts`, `google_fonts`, `link`.
- **split_line_heading**: content, `font_style` [h1…h6|p], `font_size`, `text_color`, `content_alignment`, `animation_type`, `max_width`, `link_href`.
- **nectar_highlighted_text**: content, `style` [full_text|half_text|regular_underline|text_outline|scribble|none], `highlight_color`, `text_color`.
- **nectar_btn**: `text`, `url`, `open_new_tab`, `size` [small|medium|large|jumbo|extra_jumbo], `button_style` [regular|regular-tilt|see-through|see-through-2|see-through-3|see-through-3d], `button_color_2` [Accent-Color|Extra-Color-1…3|extra-color-gradient-1…2], `color_override`, `solid_text_color_override`, `hover_color_override`, `icon_family`, `margin_top`…, `el_class`, `button_id`.
- **nectar_cta**: `text`, `link_text`, `url`, `btn_style` [see-through|arrow-animation|material|underline|text-reveal-wave|basic|next-section], `heading_tag`, `button_color`, `text_color`, `alignment`, `padding_*`, `margin_*`, `class`.
- **image_with_animation**: `image_url` (media ID), `image_size`, `alignment`, `animation`, `img_link`, `img_link_target`, `border_radius`, `box_shadow`, `max_width`, `hover_animation`, `el_class`.
- **nectar_icon**: `icon_family`, `icon_fontawesome` (etc.), `icon_size`, `icon_style`, `icon_color` (palette) or `icon_color_custom`, `url`.
- **nectar_icon_list** → `nectar_icon_list_item`: list `color`, `direction`, `columns`, `icon_size`, `icon_style`; item `icon_type` [numerical|icon], `header`, `text`.
- **fancy_box**: `box_style` [default|color_box_hover|color_box_basic|parallax_hover|hover_desc|image_above_text_underline], `image_url`, content, `link_url`, `link_text`, `min_height`, `color`, `icon_family`, `css`.
- **toggles** → `toggle`: `style` [default|minimal|minimal_shadow|minimal_small], `accordion`, `accordion_starting_functionality`; toggle `title`, `color`, `heading_tag`, content = nested elements.
- **tabbed_section** → `tab`: `style` [default|material|minimal|minimal_alt|minimal_flexible|toggle_button|vertical|vertical_modern|…], `alignment`, `tab_color`; tab `title`, `icon_family`, `sub_desc`.
- **testimonial_slider** → `testimonial`: `style` [default|minimal|multiple_visible|multiple_visible_minimal], `color`, `autorotate`; testimonial `name`, `subtitle`, `quote`, `image`, `star_rating`.
- **divider**: `custom_height` (spacing), `line_type` [No Line|Full Width Line|Small Line|Vertical Line], `line_thickness`, `divider_color`.
- **nectar_global_section**: `id` (the Global Section post ID).
- **gravityform**: `id` (form), `title`, `description`, `ajax`.
- **vc_raw_html**: content is base64; `el_class`, `el_id`.
