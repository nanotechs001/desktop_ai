/**
 * Brand images from assets/branding/logo-mark.webp (the transparent robot):
 *   resources/app.png, app_dev.png, icon.png (512 px), app.ico (16–256 px, PNG-encoded entries),
 *   public/pwa/icon-180/192/512.png and renderer/assets/logos/brand/app.png (in-app logo, 256 px).
 *
 *   node tools/build-app-icons.cjs
 *
 * macOS app.icns is not generated (needs Apple's iconutil); rebuild it on a Mac from resources/app.png.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const branding = path.join(root, 'assets/branding');
const resources = path.join(root, 'resources');
const clear = { r: 0, g: 0, b: 0, alpha: 0 };
/** An .ico whose entries are PNG images (supported since Windows Vista). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

(async () => {
  // Every icon is the transparent robot, trimmed, with a small margin to match other apps' icons.
  const icon = await sharp(path.join(branding, 'logo-mark.webp')).trim().png().toBuffer();
  const png = (size) => {
    const inner = Math.round(size * 0.92);
    const before = Math.floor((size - inner) / 2);
    const after = size - inner - before;
    return sharp(icon)
      .resize(inner, inner, { fit: 'contain', background: clear })
      .extend({ top: before, bottom: after, left: before, right: after, background: clear })
      .png()
      .toBuffer();
  };

  const big = await png(512);
  for (const name of ['app.png', 'app_dev.png', 'icon.png']) fs.writeFileSync(path.join(resources, name), big);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(
    path.join(resources, 'app.ico'),
    buildIco(await Promise.all(sizes.map(async (size) => ({ size, data: await png(size) }))))
  );
  for (const size of [180, 192, 512]) {
    fs.writeFileSync(path.join(root, 'public/pwa', `icon-${size}.png`), await png(size));
  }

  const mark = await sharp(icon).resize(256, 256, { fit: 'contain', background: clear }).png().toBuffer();
  fs.writeFileSync(path.join(root, 'packages/desktop/src/renderer/assets/logos/brand/app.png'), mark);
  console.log('written: resources/app.png, app_dev.png, icon.png, app.ico, public/pwa icons, in-app brand app.png');
})();
