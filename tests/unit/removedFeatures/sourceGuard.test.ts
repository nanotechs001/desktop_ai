/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Teams, Pet, Butler and Feedback are removed from this fork by hiding their
 * entry points; their source stays. This guard fails when any renderer file
 * mounts one of the hidden UI pieces again.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const rendererRoot = path.resolve(__dirname, '../../../packages/desktop/src/renderer');

const listSourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });

const HIDDEN_JSX = [
  '<FeedbackButton',
  '<ButlerDiagnoseButton',
  '<TeamSiderSection',
  '<FeedbackReportModal',
  '<FeedbackProvider',
  '<PetSettings',
];

describe('hidden entry points stay unmounted', () => {
  const files = listSourceFiles(rendererRoot);

  it.each(HIDDEN_JSX)('nothing renders %s', (marker) => {
    // A component's own file (comments, recursion) and the unmounted FeedbackContext provider may name it.
    const owners = new Set([`${marker.slice(1)}.tsx`, 'FeedbackContext.tsx']);
    const mounts = files.filter(
      (file) => !owners.has(path.basename(file)) && fs.readFileSync(file, 'utf-8').includes(marker)
    );
    expect(mounts).toEqual([]);
  });

  it('the app root does not mount the feedback provider', () => {
    const main = fs.readFileSync(path.join(rendererRoot, 'main.tsx'), 'utf-8');
    expect(main).not.toContain('FeedbackProvider');
  });
});
