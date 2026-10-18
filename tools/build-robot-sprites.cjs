/**
 * Packs the floating robot's 30 FPS animation frames into one horizontal WebP strip per state.
 *
 *   node tools/build-robot-sprites.cjs
 *
 * Source of truth: assets/ai-robot-concepts/animation-strips-v1/animation-30fps-manifest.json.
 * For every state it reads `framePattern` (444×444 transparent PNGs) and writes
 * packages/desktop/src/renderer/assets/agentWidget/<state>.webp (`frameCount` cells × 176 px, 2× the 88 px robot),
 * then copies the playback fields the app needs to packages/desktop/src/common/config/robotAnimationManifest.json.
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const assetDir = path.join(root, 'assets/ai-robot-concepts/animation-strips-v1');
const outDir = path.join(root, 'packages/desktop/src/renderer/assets/agentWidget');
const manifestOut = path.join(root, 'packages/desktop/src/common/config/robotAnimationManifest.json');
const CELL = 176;
const clear = { r: 0, g: 0, b: 0, alpha: 0 };
const FIELDS = [
  'fps',
  'loop',
  'frameCount',
  'keyframeDurationMs',
  'sourceDurationMs',
  'outputDurationMs',
  'framePattern',
  'preview',
];

const framePath = (pattern, n) =>
  path.join(
    assetDir,
    pattern.replace(/%0(\d)d/, (_, w) => String(n).padStart(Number(w), '0'))
  );

/**
 * Some frames were cut from a 4×2 sheet and carry a sliver of the robot from the row above (its hover foot)
 * along their top edge. Erase any shape that touches the top edge but stays in the top quarter of the frame —
 * the robot itself never reaches that high. Returns the number of pixels cleared.
 */
function eraseTopEdgeBleed(data, width, height) {
  const opaque = (i) => data[i * 4 + 3] > 8;
  const limit = Math.floor(height / 4);
  const seen = new Uint8Array(width * height);
  let erased = 0;
  for (let x = 0; x < width; x++) {
    if (!opaque(x) || seen[x]) continue;
    const region = [];
    const stack = [x];
    seen[x] = 1;
    let reachesDown = false;
    while (stack.length) {
      const i = stack.pop();
      region.push(i);
      const px = i % width;
      const py = (i - px) / width;
      if (py >= limit) reachesDown = true;
      for (const [nx, ny] of [
        [px + 1, py],
        [px - 1, py],
        [px, py + 1],
        [px, py - 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (!seen[n] && opaque(n)) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (reachesDown) continue;
    for (const i of region) data[i * 4 + 3] = 0;
    erased += region.length;
  }
  return erased;
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(assetDir, 'animation-30fps-manifest.json'), 'utf8'));
  const states = {};
  for (const [state, spec] of Object.entries(manifest.states)) {
    const files = Array.from({ length: spec.frameCount }, (_, i) => framePath(spec.framePattern, i + 1));
    const missing = files.find((f) => !fs.existsSync(f));
    if (missing) throw new Error(`${state}: missing ${path.relative(root, missing)}`);
    const cells = await Promise.all(
      files.map(async (f) => {
        const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const erased = eraseTopEdgeBleed(data, info.width, info.height);
        if (erased) console.log(`  ${path.basename(f)}: erased ${erased} px of a neighbouring cell at the top edge`);
        return sharp(data, { raw: info }).resize(CELL, CELL, { fit: 'contain', background: clear }).png().toBuffer();
      })
    );
    const out = path.join(outDir, `${state}.webp`);
    await sharp({ create: { width: CELL * cells.length, height: CELL, channels: 4, background: clear } })
      .composite(cells.map((input, i) => ({ input, left: i * CELL, top: 0 })))
      .webp({ quality: 82, alphaQuality: 90, effort: 6 })
      .toFile(out);
    states[state] = Object.fromEntries(FIELDS.map((k) => [k, spec[k]]));
    console.log(`${state}: ${files.length} frames -> ${path.relative(root, out)}`);
  }
  fs.writeFileSync(
    manifestOut,
    `${JSON.stringify({ version: manifest.version, fps: manifest.fps, cellPx: CELL, states }, null, 2)}\n`
  );
  console.log(`manifest -> ${path.relative(root, manifestOut)}`);
})();
