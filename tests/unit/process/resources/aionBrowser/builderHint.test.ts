/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { builderHint } from '@process/resources/builtinMcp/aionBrowser/builderHint';

type Seen = Parameters<typeof builderHint>[0];
const page = (urls: string[], frameLabels: string[] = [], rowLabels: string[] = []): Seen => ({
  urls,
  frames: frameLabels.map((label) => ({ label })),
  rows: rowLabels.map((label) => ({ label })),
});

// A VA bot built a Salient page one click at a time and never loaded its page-builder skill; observe now says which
// builder it is on and which notes to read, at the moment it looks at the page.
describe('builderHint', () => {
  it('names WPBakery on Salient from the Frontend Editor or the editor switch buttons', () => {
    const inline = builderHint(
      page(['https://a.test/wp-admin/post.php?vc_action=vc_inline&post_id=6&post_type=page'], ['vc_inline-frame'])
    );
    expect(inline).toContain('WPBakery');
    expect(inline).toContain('references/salient-wpbakery.md');
    expect(
      builderHint(page(['https://a.test/wp-admin/post.php?post=6&action=edit'], [], ['Backend Editor']))
    ).toContain('references/salient-wpbakery.md');
  });

  it('names Elementor, GoHighLevel and the block editor by their own signs', () => {
    expect(builderHint(page(['https://a.test/wp-admin/post.php?post=6&action=elementor']))).toContain(
      'references/elementor.md'
    );
    expect(builderHint(page(['https://app.gohighlevel.com/v2/location/x/page-builder/y']))).toContain(
      'references/ghl.md'
    );
    expect(builderHint(page(['https://crm.example.com/x'], ['funnel-builder']))).toContain('references/ghl.md');
    expect(builderHint(page(['https://a.test/wp-admin/post-new.php'], [], ['Toggle block inserter']))).toContain(
      'references/gutenberg.md'
    );
  });

  it('says nothing on an ordinary page, and asks to load the page-builder skill when it names one', () => {
    expect(builderHint(page(['https://example.com/'], [], ['Sign in']))).toBeNull();
    expect(builderHint(page(['https://a.test/wp-admin/post.php?vc_action=vc_inline']))).toMatch(/page-builder skill/);
  });
});
