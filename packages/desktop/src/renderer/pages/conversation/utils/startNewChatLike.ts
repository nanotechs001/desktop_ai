/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type {
  IMcpServer,
  ISessionMcpServer,
  TChatConversation,
  TConversationAssistantIdentity,
  TProviderWithModel,
} from '@/common/config/storage';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { withBrowserMcp } from '@/renderer/hooks/mcp/withBrowserMcp';
import { getClientBusinessSetting } from '@/renderer/services/clientBusinessSettings';
import { emitter } from '@/renderer/utils/emitter';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import { getConversationOrNull } from './conversationCache';

/**
 * The `extra` keys a new chat with the same assistant takes from `source`: its engine, identity and chosen settings.
 * An allowlist, so nothing bound to the old chat rides along: its schedule (`cronJobId`/`cron_job_id`), team, fork,
 * backend session, usage, pin or first-turn files. The backend re-resolves the rest from the assistant. Session MCP
 * servers are rebuilt from the catalog instead (see `freshSessionMcpServers`).
 */
const CARRIED_EXTRA_KEYS = [
  'workspace',
  'backend',
  'cli_path',
  'agent_name',
  'custom_agent_id',
  'agent_id',
  'agent_source',
  'preset_assistant_id',
  'session_mode',
  'current_model_id',
  'sandboxMode',
  'codexModel',
  'skills',
] as const;

/** Keys that belong to the source's engine; a new chat on another engine starts with that engine's own defaults. */
const ENGINE_BOUND_EXTRA_KEYS: ReadonlySet<string> = new Set([
  'backend',
  'cli_path',
  'agent_name',
  'custom_agent_id',
  'agent_id',
  'agent_source',
  'session_mode',
  'current_model_id',
  'sandboxMode',
  'codexModel',
]);

/** How the new chat differs from its source. */
export type NewChatChange = {
  /** Run on this engine instead of the source's. */
  engine?: Pick<ManagedAgent, 'id' | 'agent_type' | 'backend'>;
  /** The aionrs provider model, as the chat model selector stores it. */
  model?: TProviderWithModel;
  /** Run as this assistant instead of the source's (an engine chat moving to another engine's own entry). */
  assistant?: TConversationAssistantIdentity;
  /** Start in this permission mode, over the assistant's default (its `permission` override). */
  sessionMode?: string;
  /** Start on this CLI engine model, over the assistant's default (its `model` override). */
  acpModel?: string;
  /** Start at this thinking level, over the assistant's default (its `thought_level` override). */
  thoughtLevel?: string;
};

/**
 * The MCP catalog. When the full list cannot be fetched (the user servers come from the backend), fall back to the
 * built-in records alone, so a new chat still gets the built-in session MCPs; the failure is logged, not thrown.
 */
async function loadMcpCatalog(): Promise<IMcpServer[]> {
  try {
    return (await ensureBackendMcpCatalog()).allServers;
  } catch (error) {
    console.error('[startNewChatLike] Could not load the MCP catalog; using the built-in servers only:', error);
    const local = await getClientBusinessSetting('mcp.config').catch((settingError: unknown): undefined => {
      console.error('[startNewChatLike] Could not load the built-in MCP servers:', settingError);
      return undefined;
    });
    return ((local ?? []) as IMcpServer[]).filter((server) => server.builtin === true);
  }
}

/**
 * The source's session MCP servers re-read from the catalog, plus every built-in session MCP. The stored copy can be
 * stale (and `create` only reads `selected_session_mcp_servers`), so a carried list would not refresh it.
 */
async function freshSessionMcpServers(stored: unknown): Promise<ISessionMcpServer[]> {
  const catalog = await loadMcpCatalog();
  const previous = Array.isArray(stored) ? (stored as ISessionMcpServer[]) : [];
  const refreshed = previous.map((server) => {
    const record = catalog.find((item) => item.id === server.id);
    return record ? toSessionMcpServer(record) : server;
  });
  return withBrowserMcp(refreshed, catalog);
}

/**
 * Creates an empty chat with the same assistant, engine, model and settings as `source` (or as `change` says), over
 * the aioncore HTTP API (so it also works in the WebUI). The backend resolves the assistant's current engine, rule,
 * notes and skills for the new chat. Returns the new conversation's id, or null when the backend made none.
 */
export async function startNewChatLike(source: TChatConversation, change: NewChatChange = {}): Promise<string | null> {
  // The stored copy, so settings changed since the page loaded (e.g. session mode) carry over.
  const latest = (await getConversationOrNull(source.id)) ?? source;
  const sourceExtra: Record<string, unknown> = latest.extra ?? {};
  const { engine, sessionMode } = change;
  const identity = change.assistant ?? latest.assistant;
  // The backend sets mode, model and thinking level from the assistant's resolved defaults, so the overrides are what
  // make them stick.
  const overrides = Object.fromEntries(
    Object.entries({ permission: sessionMode, model: change.acpModel, thought_level: change.thoughtLevel }).filter(
      ([, value]) => value
    )
  );
  const assistant =
    identity && Object.keys(overrides).length > 0 ? { ...identity, conversation_overrides: overrides } : identity;
  // A temporary folder belongs to its chat: without a workspace the backend makes a fresh one, as for any new chat.
  const dropWorkspace = sourceExtra.is_temporary_workspace === true;
  const carried = CARRIED_EXTRA_KEYS.filter(
    (key) =>
      key in sourceExtra &&
      !(dropWorkspace && key === 'workspace') &&
      !(engine && ENGINE_BOUND_EXTRA_KEYS.has(key)) &&
      // A replaced assistant's id must not ride along: the backend would resolve the old assistant from it.
      !(change.assistant && key === 'preset_assistant_id')
  );
  const extra: Record<string, unknown> = {
    ...Object.fromEntries(carried.map((key) => [key, sourceExtra[key]])),
    // A chat without any assistant names its engine in `extra`, as such chats always have.
    ...(engine && !assistant ? { agent_id: engine.id, backend: engine.backend } : {}),
    ...(sessionMode ? { session_mode: sessionMode } : {}),
    selected_session_mcp_servers: await freshSessionMcpServers(sourceExtra.session_mcp_servers),
  };
  const type: TChatConversation['type'] = engine?.agent_type ?? latest.type;
  // Only what creating the chat needs: never its source/channel binding, history or runtime state.
  // aionrs only: the other types carry their model in `extra`, and the backend rejects a top-level one.
  const model = type === 'aionrs' ? (change.model ?? ('model' in latest ? latest.model : undefined)) : undefined;
  const conversation = { type, model, assistant, name: '', extra };
  const created = await ipcBridge.conversation.createWithConversation.invoke({
    conversation: conversation as TChatConversation,
  });
  if (!created?.id) return null;
  emitter.emit('chat.history.refresh');
  return created.id;
}
