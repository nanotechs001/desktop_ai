# Elementor (WordPress)

## Where things are
- Left panel: **Elements** (widgets) and **Globals**; the gear/site menu has **Site Settings** (global colors, global fonts, typography, buttons, layout).
- Structure: **Containers** (flexbox/grid) in current Elementor; older sites use Section → Column → Widget.
- A selected widget's panel has **Content / Style / Advanced** tabs. Advanced holds margin/padding, CSS ID and classes, responsive visibility, and **Custom CSS** (Elementor Pro only).
- **Navigator** (layers) shows the tree for fast selecting; the folder icon opens the **template library** (blocks/pages, saved templates).
- Responsive mode switches desktop/tablet/mobile; most style values can be set per device.

## Fast path
1. Set **Site Settings → global colors and fonts** first; pick them in widgets instead of raw values.
2. Insert a template block close to the target, or build one container and **duplicate** it (right-click → Duplicate, or Ctrl/Cmd+D).
3. Use right-click **Copy / Paste Style** to repeat a widget's look.
4. Use the Navigator to select nested items instead of hunting on the canvas.
5. Only then: a CSS class plus Custom CSS (Pro), or the theme's Additional CSS.
6. Click **Update/Publish** to save (Elementor does not autosave to the live page).
