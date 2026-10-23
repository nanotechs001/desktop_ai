/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A deleted bot's profile folder that could not be removed right away. On Windows the live session keeps its files
 * open (cookies, local storage) and an open file cannot be deleted, so the folder is queued and removed at the next
 * start, before anything opens it again. Its browsing data was already cleared by then.
 *
 * The queue holds folder names only, and only bot profile folders directly under `Partitions` are ever removed.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const PARTITIONS_DIR = 'Partitions';
const QUEUE_FILE = '.pending-removal.json';
const AGENT_FOLDER = /^aionui-agent-[0-9a-f]{32}$/;

const partitionsRoot = (userDataDir: string): string => path.resolve(userDataDir, PARTITIONS_DIR);
const queuePath = (userDataDir: string): string => path.join(partitionsRoot(userDataDir), QUEUE_FILE);

const readQueue = async (userDataDir: string): Promise<string[]> => {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(queuePath(userDataDir), 'utf-8'));
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === 'string') : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[BrowserProfiles] unreadable profile removal queue, starting it over:', error);
    }
    return [];
  }
};

const writeQueue = async (userDataDir: string, names: string[]): Promise<void> => {
  if (names.length === 0) {
    await fs.rm(queuePath(userDataDir), { force: true });
    return;
  }
  await fs.writeFile(queuePath(userDataDir), JSON.stringify(names));
};

/** Queues `folder` (a bot profile folder under `<userData>/Partitions`) for removal at the next start. */
export async function deferProfileRemoval(userDataDir: string, folder: string): Promise<void> {
  const name = path.basename(folder);
  if (path.dirname(path.resolve(folder)) !== partitionsRoot(userDataDir) || !AGENT_FOLDER.test(name)) {
    throw new Error('Only a bot browser profile folder can be queued for removal');
  }
  const queue = await readQueue(userDataDir);
  if (!queue.includes(name)) await writeQueue(userDataDir, [...queue, name]);
}

/** Removes the queued folders; one that still cannot be removed stays queued for the start after. */
export async function removeDeferredProfileDirs(userDataDir: string): Promise<void> {
  const queue = await readQueue(userDataDir);
  if (queue.length === 0) return;
  const names = queue.filter((name) => AGENT_FOLDER.test(name));
  const results = await Promise.allSettled(
    names.map((name) => fs.rm(path.join(partitionsRoot(userDataDir), name), { recursive: true, force: true }))
  );
  const left = names.filter((name, i) => {
    const result = results[i];
    if (result.status === 'fulfilled') return false;
    console.warn(`[BrowserProfiles] could not remove the deleted bot profile ${name} yet:`, result.reason);
    return true;
  });
  await writeQueue(userDataDir, left);
}
