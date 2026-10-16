/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useMemo, useReducer } from 'react';
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

/**
 * The partition a browser tab of `profile` must use: Personal's at once, an Agent's once main has set its session up
 * (null until then, and after a failure, which is logged). A webview's partition can't change after it attaches, so
 * the caller mounts the webview only once this is known.
 */
export function useProfilePartition(profile: BrowserTabProfile | undefined): string | null {
  const agentId = profile?.kind === 'agent' ? profile.agentId : null;
  const [, refresh] = useReducer((count: number) => count + 1, 0);

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
      .catch((error: unknown) => console.warn('[BrowserProfiles] could not set up the Agent browser profile:', error));
    return () => {
      live = false;
    };
  }, [agentId]);

  if (agentId === null) return BROWSER_SESSION_PARTITION;
  return agentPartitions.get(agentId) ?? null;
}
