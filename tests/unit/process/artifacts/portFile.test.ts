/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLastPort } from '@process/artifacts';

describe('artifact server port file', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-port-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const read = async (contents: string): Promise<number | undefined> => {
    await fs.writeFile(path.join(root, 'server.json'), contents);
    return readLastPort(root);
  };

  it.each([1024, 8080, 65535])('accepts the integer port %i', async (port) => {
    expect(await read(JSON.stringify({ port }))).toBe(port);
  });

  it.each([0, 1, 80, 1023, 65536, 70000, -1, 8080.5])(
    'rejects the out-of-range or fractional port %s',
    async (port) => {
      expect(await read(JSON.stringify({ port }))).toBeUndefined();
    }
  );

  it.each(['"8080"', 'null', 'true', '[]'])('rejects the non-number port value %s', async (value) => {
    expect(await read(`{"port":${value}}`)).toBeUndefined();
  });

  it('ignores a missing, empty or malformed file', async () => {
    expect(await readLastPort(root)).toBeUndefined();
    expect(await read('')).toBeUndefined();
    expect(await read('not json')).toBeUndefined();
    expect(await read('{}')).toBeUndefined();
  });
});
