/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { BrowserTabProfile } from '@/common/types/browser';

/** The SWR key every assistant-list reader shares, so the profile UI reuses the cached list. */
const ASSISTANTS_KEY = 'assistants.list';

/** Partitions main already set up, by Agent id; a partition is fixed for an Agent, so it never goes stale. */
/** Partitions main has set up, keyed by {@link profileKeyOf}. */
const profilePartitions = new Map<string, string>();

/** A stable key per browser profile: Personal, one Agent's, or one regular chat's temporary session. */
export const profileKeyOf = (profile: BrowserTabProfile | undefined): string =>
  profile?.kind === 'agent'
    ? `agent:${profile.agentId}`
    : profile?.kind === 'temporary'
      ? `temporary:${profile.conversationId}`
      : 'personal';

/**
 * The Agents that have a browser profile: the ones the user made (built-ins have none). Loads the list only when
 * `enabled`, so a Personal tab never asks for it.
 */
export function useProfileAgents(enabled = true): Assistant[] {
  const { data } = useSWR<Assistant[]>(enabled ? ASSISTANTS_KEY : null, () => ipcBridge.assistants.list.invoke());
  return useMemo(() => (data ?? []).filter((agent) => agent.source !== 'builtin'), [data]);
}

/** A tab's partition: set once main has the profile up; `error` says why it could not be, until `retry`. */
export type ProfilePartition = { partition: string | null; error: string | null; retry: () => void };

/**
 * The partition a browser tab of `profile` must use: Personal's at once, an Agent's once main has set its session up.
 * Until then `partition` is null; after a failure (logged) `error` holds the reason and `retry` asks again. A
 * webview's partition can't change after it attaches, so the caller mounts the webview only once it is known.
 */
export function useProfilePartition(profile: BrowserTabProfile | undefined): ProfilePartition {
  // Personal is always ready; an Agent's or a temporary chat session is set up by main on first use.
  const key = profileKeyOf(profile);
  const remote = profile && profile.kind !== 'personal' ? profile : null;
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (remote === null || profilePartitions.has(key)) return;
    let live = true;
    ipcBridge.browser.profilePartition
      .invoke(remote)
      .then((reply) => {
        if (!reply.success || !reply.data) throw new Error(reply.msg ?? 'no partition');
        profilePartitions.set(key, reply.data);
        if (live) refresh();
      })
      .catch((error: unknown) => {
        console.warn('[BrowserProfiles] could not set up the browser profile:', error);
        if (live) setFailure({ key, message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
    // `remote` is fully described by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const retry = useCallback(() => {
    setFailure(null);
    setAttempt((count) => count + 1);
  }, []);

  if (remote === null) return { partition: BROWSER_SESSION_PARTITION, error: null, retry };
  const error = failure?.key === key ? failure.message : null;
  return { partition: profilePartitions.get(key) ?? null, error, retry };
}
