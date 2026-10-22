/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * The page builder a page shows, told to the agent in observe: a VA bot built a Salient page one click at a time and
 * never loaded its page-builder skill, so the hint comes where every engine looks, the observation. The signs are the
 * skill's own ("Identify the builder" in builtin-skills/auto-inject/page-builder/SKILL.md).
 */

/** What observe saw that a builder shows in: every frame's url, frame labels, control labels. */
export type BuilderSigns = {
  urls?: readonly string[];
  frames: ReadonlyArray<{ label: string }>;
  rows: ReadonlyArray<{ label: string }>;
};

type Signs = Required<BuilderSigns>;
type Builder = { name: string; reference: string; matches: (signs: Signs) => boolean };

const anyUrl = (signs: Signs, pattern: RegExp): boolean => signs.urls.some((url) => pattern.test(url));
const anyFrame = (signs: Signs, label: string): boolean => signs.frames.some((frame) => frame.label === label);
const anyRow = (signs: Signs, labels: readonly string[]): boolean =>
  signs.rows.some((row) => labels.includes(row.label));

const BUILDERS: readonly Builder[] = [
  {
    name: 'WPBakery (Salient)',
    reference: 'references/salient-wpbakery.md',
    matches: (s) =>
      anyUrl(s, /[?&]vc_action=vc_inline\b/) ||
      anyFrame(s, 'vc_inline-frame') ||
      anyRow(s, ['Backend Editor', 'Frontend Editor', 'Classic Mode']),
  },
  {
    name: 'Elementor',
    reference: 'references/elementor.md',
    matches: (s) => anyUrl(s, /[?&]action=elementor\b|[?&]elementor-preview=/),
  },
  {
    name: 'GoHighLevel',
    reference: 'references/ghl.md',
    matches: (s) => anyUrl(s, /\/\/app\.gohighlevel\.com\/|\/page-builder\//) || anyFrame(s, 'funnel-builder'),
  },
  {
    name: 'the WordPress block editor',
    reference: 'references/gutenberg.md',
    matches: (s) =>
      anyUrl(s, /\/wp-admin\/(post|post-new|site-editor)\.php/) &&
      anyRow(s, ['Toggle block inserter', 'Block Inserter']),
  },
];

/** The hint line for the builder `signs` show, or null when the page is no known builder. */
export function builderHint(signs: BuilderSigns): string | null {
  const seen: Signs = { urls: signs.urls ?? [], frames: signs.frames, rows: signs.rows };
  const builder = BUILDERS.find((candidate) => candidate.matches(seen));
  if (!builder) return null;
  return `Page builder: ${builder.name}. Before building, load the page-builder skill and read its ${builder.reference}; use the builder's own fast path, not one click per element.`;
}
