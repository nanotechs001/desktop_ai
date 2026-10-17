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
const agentPartitions = new Map<string, string>();

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
  const agentId = profile?.kind === 'agent' ? profile.agentId : null;
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const [failure, setFailure] = useState<{ agentId: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (agentId === null || agentPartitions.has(agentId)) return;
    let live = true;
    ipcBridge.browser.profilePartition
      .invoke({ kind: 'agent', agentId })
      .then((reply) => {
        if (!reply.success || !reply.data) throw new Error(reply.msg ?? 'no partition');
        agentPartitions.set(agentId, reply.data);
        if (live) refresh();
      })
      .catch((error: unknown) => {
        console.warn('[BrowserProfiles] could not set up the Agent browser profile:', error);
        if (live) setFailure({ agentId, message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [agentId, attempt]);

  const retry = useCallback(() => {
    setFailure(null);
    setAttempt((count) => count + 1);
  }, []);

  if (agentId === null) return { partition: BROWSER_SESSION_PARTITION, error: null, retry };
  const error = failure?.agentId === agentId ? failure.message : null;
  return { partition: agentPartitions.get(agentId) ?? null, error, retry };
}
