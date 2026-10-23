/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deferProfileRemoval,
  removeDeferredProfileDirs,
} from '@process/services/browserSession/profiles/deferredRemoval';

const AGENT_FOLDER = `aionui-agent-${'a'.repeat(32)}`;

const userData = async (): Promise<string> => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'deferred-removal-'));
  await fs.mkdir(path.join(dir, 'Partitions', AGENT_FOLDER, 'Network'), { recursive: true });
  await fs.writeFile(path.join(dir, 'Partitions', AGENT_FOLDER, 'Network', 'Cookies'), 'x');
  return dir;
};

describe('deferred removal of a deleted bot profile folder', () => {
  it('removes a deferred folder at the next start and forgets it', async () => {
    const dir = await userData();
    const folder = path.join(dir, 'Partitions', AGENT_FOLDER);

    await deferProfileRemoval(dir, folder);
    expect(existsSync(folder)).toBe(true);
    await removeDeferredProfileDirs(dir);

    expect(existsSync(folder)).toBe(false);
    await removeDeferredProfileDirs(dir); // nothing left to do, and no error
  });

  it('only ever removes bot profile folders directly under Partitions', async () => {
    const dir = await userData();
    const outside = path.join(dir, 'keep-me');
    await fs.mkdir(outside);
    await fs.writeFile(
      path.join(dir, 'Partitions', '.pending-removal.json'),
      JSON.stringify(['../keep-me', 'not-an-agent', AGENT_FOLDER])
    );

    await removeDeferredProfileDirs(dir);

    expect(existsSync(outside)).toBe(true);
    expect(existsSync(path.join(dir, 'Partitions', AGENT_FOLDER))).toBe(false);
  });

  it('refuses to defer a folder that is not a bot profile under Partitions', async () => {
    const dir = await userData();

    await expect(deferProfileRemoval(dir, path.join(dir, 'other'))).rejects.toThrow();
  });
});
