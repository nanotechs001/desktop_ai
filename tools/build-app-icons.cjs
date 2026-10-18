/**
 * Brand images from assets/branding/logo-mark.webp (the transparent robot):
 *   resources/app.png, app_dev.png, icon.png (512 px), app.ico (16–256 px, PNG-encoded entries),
 *   public/pwa/icon-180/192/512.png and renderer/assets/logos/brand/app.png (in-app logo, 256 px),
 *   resources/app.icns (macOS, 16–1024 px incl. @2x, PNG-encoded entries; no Mac or iconutil needed),
 *   mobile/assets/images/icon.png (1024 px on an opaque background, as iOS requires) and
 *   mobile/assets/images/adaptive-icon.png (Android adaptive-icon foreground, robot inside the safe zone).
 *
 *   node tools/build-app-icons.cjs
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

/** macOS .icns container with PNG entries (icp4–ic14), read by macOS 10.7+ without iconutil. */
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024], // 512@2x
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic13', 256], // 128@2x
  ['ic14', 512], // 256@2x
];
function buildIcns(images) {
  const chunks = images.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + chunks.reduce((sum, c) => sum + c.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

// Mobile icon background: deep navy, so the robot's glow ring reads on both platforms' masks.
const MOBILE_ICON_BG = '#0E1630';

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

  fs.writeFileSync(
    path.join(resources, 'app.icns'),
    buildIcns(await Promise.all(ICNS_TYPES.map(async ([type, size]) => ({ type, data: await png(size) }))))
  );

  // Robot centred at `scale` of a 1024 px canvas, on `background` (opaque) or transparent.
  const mobileIcon = async (scale, background) => {
    const inner = Math.round(1024 * scale);
    const robot = await sharp(icon).resize(inner, inner, { fit: 'contain', background: clear }).png().toBuffer();
    return sharp({ create: { width: 1024, height: 1024, channels: 4, background: background ?? clear } })
      .composite([{ input: robot, gravity: 'centre' }])
      .png()
      .toBuffer();
  };
  const mobileImages = path.join(root, 'mobile/assets/images');
  // iOS rejects icons with transparency; flatten onto the background.
  fs.writeFileSync(
    path.join(mobileImages, 'icon.png'),
    await sharp(await mobileIcon(0.74, MOBILE_ICON_BG))
      .flatten({ background: MOBILE_ICON_BG })
      .png()
      .toBuffer()
  );
  // Android crops adaptive icons to a circle/squircle: keep the robot inside the central 66 % safe zone.
  fs.writeFileSync(path.join(mobileImages, 'adaptive-icon.png'), await mobileIcon(0.6));
  console.log(
    'written: resources/app.png, app_dev.png, icon.png, app.ico, app.icns, public/pwa icons, in-app brand app.png, ' +
      'mobile icon.png and adaptive-icon.png'
  );
})();
