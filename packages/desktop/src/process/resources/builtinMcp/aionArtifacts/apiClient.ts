/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Client for the loopback artifact server's token API. Shared by the built-in MCPs that talk to it. Uses only Node's
 * global fetch, so the standalone MCP bundle needs no Electron.
 */

export const ARTIFACTS_UNAVAILABLE = 'Artifacts are unavailable (local server not running)';

const REQUEST_TIMEOUT_MS = 15_000;

export type ApiOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

export type ArtifactsApi = {
  /** POSTs `{ conversationId, ...body }` to `path` (e.g. `/api/artifacts/create`). Never throws. */
  post<T>(path: string, body: Record<string, unknown>): Promise<ApiOutcome<T>>;
  /** The server origin; null when the env is incomplete. */
  origin: string | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Reads AION_ARTIFACTS_URL, AION_ARTIFACTS_TOKEN and AIONUI_CONVERSATION_ID. With any of them missing every call
 * answers {@link ARTIFACTS_UNAVAILABLE}. Store failures come back as HTTP 200 with `ok:false` and are passed on with
 * the store's message; transport and 4xx failures become short readable messages, never stacks.
 */
export function createArtifactsApi(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): ArtifactsApi {
  const origin = env.AION_ARTIFACTS_URL || null;
  const token = env.AION_ARTIFACTS_TOKEN;
  const conversationId = env.AIONUI_CONVERSATION_ID;
  if (!origin || !token || !conversationId) {
    return { origin: null, post: async () => ({ ok: false, message: ARTIFACTS_UNAVAILABLE }) };
  }

  return {
    origin,
    async post<T>(path: string, body: Record<string, unknown>): Promise<ApiOutcome<T>> {
      let response: Response;
      try {
        response = await fetchImpl(new URL(path, origin), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...body, conversationId }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, message: ARTIFACTS_UNAVAILABLE };
      }
      const payload = asRecord(await response.json().catch((): unknown => null));
      const message = typeof payload?.message === 'string' ? payload.message : null;
      if (response.status === 401) return { ok: false, message: 'Artifacts rejected this session (bad token)' };
      if (response.status === 413) return { ok: false, message: message ?? 'The artifact is too large' };
      if (response.status !== 200 || !payload) {
        return { ok: false, message: message ?? `Artifacts request failed (HTTP ${response.status})` };
      }
      if (payload.ok !== true) return { ok: false, message: message ?? 'Artifacts request failed' };
      return { ok: true, value: payload.value as T };
    },
  };
}
