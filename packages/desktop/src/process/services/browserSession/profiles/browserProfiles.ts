/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import type { BrowserTabProfile } from '@/common/types/browser';
import { AGENT_ID_RE } from '@process/artifacts/notes';

/*
 * Browser profiles (ruling N-15): Personal is the user's own session; every Agent gets a persistent partition
 * named after a hash of its id, because real ids (`bare:632f31d2`, up to 128 chars) are not safe folder names.
 */

const PERSIST_PREFIX = 'persist:';
const AGENT_PARTITION_PREFIX = `${PERSIST_PREFIX}aionui-agent-`;
const PARTITION_HASH_CHARS = 32;
const PARTITIONS_DIR = 'Partitions';

export const PERSONAL_PROFILE: BrowserTabProfile = { kind: 'personal' };

/** Which Agent each partition computed in this process belongs to; never stored. */
const agentIdByPartition = new Map<string, string>();
/** The partition of every browser session that was set up (see ensureBrowserSession). */
const partitionBySession = new Map<Electron.Session, string>();
/** Partitions whose Agent's browser data was deleted in this run: never a browser profile again. */
const deletedPartitions = new Set<string>();
const deletedListeners = new Set<(agentId: string) => void>();

/**
 * The persistent partition of an Agent's browser profile: `persist:aionui-agent-` plus the first 32 hex chars
 * of sha256(agentId). Throws for an id that is not an Agent id.
 */
export function agentPartition(agentId: string): string {
  if (!AGENT_ID_RE.test(agentId)) throw new Error('Invalid Agent id');
  const hash = createHash('sha256').update(agentId).digest('hex').slice(0, PARTITION_HASH_CHARS);
  const partition = `${AGENT_PARTITION_PREFIX}${hash}`;
  agentIdByPartition.set(partition, agentId);
  return partition;
}

/** The Electron partition a profile's tabs use. Throws for a malformed Agent id. */
export const partitionOfProfile = (profile: BrowserTabProfile): string =>
  profile.kind === 'personal' ? BROWSER_SESSION_PARTITION : agentPartition(profile.agentId);

/** The profile behind a partition: Personal, an Agent this process computed the partition for, or null. */
export function profileOfPartition(partition: string): BrowserTabProfile | null {
  if (partition === BROWSER_SESSION_PARTITION) return PERSONAL_PROFILE;
  if (deletedPartitions.has(partition)) return null;
  const agentId = agentIdByPartition.get(partition);
  return agentId === undefined ? null : { kind: 'agent', agentId };
}

/** A profile from untrusted input (the renderer), with a valid Agent id; null otherwise. */
export function parseBrowserTabProfile(value: unknown): BrowserTabProfile | null {
  if (typeof value !== 'object' || value === null) return null;
  const { kind, agentId } = value as { kind?: unknown; agentId?: unknown };
  if (kind === 'personal') return PERSONAL_PROFILE;
  if (kind === 'agent' && typeof agentId === 'string' && AGENT_ID_RE.test(agentId)) return { kind, agentId };
  return null;
}

/** Records that `session` is the browser session of `partition`. */
export function rememberBrowserSession(partition: string, session: Electron.Session): void {
  partitionBySession.set(session, partition);
}

/** The partition of a browser session that was set up; null for every other session. */
export const partitionOfSession = (session: Electron.Session): string | null => partitionBySession.get(session) ?? null;

/** True once the Agent's browser data was deleted in this run; its chats then use the default Agent profile. */
export const isDeletedAgentProfile = (agentId: string): boolean => deletedPartitions.has(agentPartition(agentId));

/** Calls `listener` with the id of each Agent whose browser data is deleted. Returns an unsubscribe. */
export function onAgentProfileDeleted(listener: (agentId: string) => void): () => void {
  deletedListeners.add(listener);
  return () => {
    deletedListeners.delete(listener);
  };
}

/** The profile of a browser session that was set up; null for every other session. */
export const profileOfSession = (session: Electron.Session): BrowserTabProfile | null => {
  const partition = partitionOfSession(session);
  return partition === null ? null : profileOfPartition(partition);
};

type ClearableSession = Pick<Electron.Session, 'clearStorageData' | 'clearCache' | 'clearAuthCache'>;

/** Clears a profile's cookies and storages, HTTP cache and HTTP auth cache (clearStorageData covers neither cache). */
export async function clearBrowsingData(session: ClearableSession): Promise<void> {
  await session.clearStorageData();
  await session.clearCache();
  await session.clearAuthCache();
}

type DeletableSession = ClearableSession & { readonly storagePath: string | null };

export type DeleteProfileDeps = {
  userDataDir: string;
  fromPartition(partition: string): DeletableSession;
  /** Drops the profile's tabs from the pane and closes every live page of the session. */
  closeLiveContents(session: DeletableSession, profile: BrowserTabProfile): Promise<void>;
  /** Unloads the session's extensions. */
  unloadExtensions(session: DeletableSession): void;
  removeDir(dir: string): Promise<void>;
  /** Forgets what main keeps for the partition elsewhere (session caches, remembered permissions). */
  forgetPartition(partition: string): void;
};

/**
 * Deletes an Agent's browser data for good: closes its pages, unloads its extensions, clears its session, removes
 * `<userData>/Partitions/<name>`, then forgets the partition, so it is never set up again in this run, and tells
 * {@link onAgentProfileDeleted} listeners. Refuses (throws, touching nothing) unless Electron's own storage path for
 * the partition is exactly that folder. A failed step throws and leaves the profile known.
 */
export async function deleteAgentBrowserData(agentId: string, deps: DeleteProfileDeps): Promise<void> {
  const partition = agentPartition(agentId);
  const partitionsRoot = path.resolve(deps.userDataDir, PARTITIONS_DIR);
  const folder = path.join(partitionsRoot, partition.slice(PERSIST_PREFIX.length));
  const session = deps.fromPartition(partition);
  const storagePath = session.storagePath === null ? null : path.resolve(session.storagePath);
  if (storagePath !== folder || path.dirname(folder) !== partitionsRoot) {
    throw new Error('The Agent browser profile is not where it should be; nothing was deleted');
  }
  await deps.closeLiveContents(session, { kind: 'agent', agentId });
  deps.unloadExtensions(session);
  await clearBrowsingData(session);
  await deps.removeDir(folder);

  deps.forgetPartition(partition);
  deletedPartitions.add(partition);
  for (const [known, knownPartition] of partitionBySession) {
    if (knownPartition === partition) partitionBySession.delete(known);
  }
  for (const listener of deletedListeners) {
    try {
      listener(agentId);
    } catch (error) {
      console.error('[BrowserProfiles] a profile-deleted listener failed:', error);
    }
  }
}
