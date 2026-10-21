import { ipcBridge } from '@/common';
import { Message, Spin } from '@arco-design/web-react';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import useSWR from 'swr';
import ChatConversation from './components/ChatConversation';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { previewScopeOfChat } from '@/renderer/pages/conversation/Preview/context/previewScope';
import { setCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { setCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useAutoTitle } from '@/renderer/hooks/chat/useAutoTitle';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { getSnapshotConversationProjectId } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { resolveAssistantConfigId } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { isHiddenAgentId } from '@/common/types/agent/hiddenAgents';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { DEFAULT_AGENT_SETTING_KEY } from '@/common/types/agent/defaultAgent';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { configService } from '@/common/config/configService';

/** A load faster than this shows no spinner and no dimming at all. */
const SPINNER_DELAY_MS = 150;
const PREVIOUS_CHAT_OPACITY = 0.6;

const ChatConversationIndex: React.FC = () => {
  const { id } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { closePreviewIfScopeChanged } = usePreviewContext();
  const { syncTitleFromHistory } = useAutoTitle();
  const notFoundHandledIdRef = useRef<string | undefined>(undefined);
  const [storedDefaultAgentId] = useConfig(DEFAULT_AGENT_SETTING_KEY);
  const defaultConversationTitle = t('conversation.welcome.newConversation');

  // keepPreviousData: a cold switch keeps the last chat on screen (dimmed, below) until the next one loads, instead of
  // unmounting the whole layout, header, panes and the browser slot, behind a spinner.
  const { data, isLoading, mutate } = useSWR(
    id ? `conversation/${id}` : null,
    () => {
      return getConversationOrNull(id!);
    },
    { keepPreviousData: true }
  );
  const showingPrevious = Boolean(data && id && data.id !== id);

  // Enter the preview scope once per conversation and scope, not on every render or data refresh.
  // The scope is the chat's VA Bot's, else `previewScopeKey` = project (falling back to workspace until the backend
  // populates project_id). Same-scope conversations keep their preview; entering one reopens it unless the
  // user closed it. When project_id arrives for the conversation we are already in, the live tabs
  // follow the scope change (`carryFromScope`) instead of being swapped for the project's saved ones.
  // The ref lives in PreviewContext (app-root level) so it survives remounts.
  const enterScopeRef = useRef(closePreviewIfScopeChanged);
  enterScopeRef.current = closePreviewIfScopeChanged;
  const lastEnteredRef = useRef<{ conversationId: string; scope: string | null } | null>(null);
  const conversationId = data?.id;
  // A chat of a VA Bot lives in the bot's one scope, shared by all of its chats: moving between them changes nothing
  // in the pane. Whether an Agent is a bot depends on the default Agent's id (an adopted default Agent is no bot), so
  // a chat of an Agent waits for it, unless the settings have loaded without one.
  const [configLoaded, setConfigLoaded] = useState(() => configService.isInitialized());
  const knowsBots = storedDefaultAgentId !== undefined || configLoaded;
  const waitsForBots = Boolean(data?.assistant?.id) && !knowsBots;
  useEffect(() => {
    if (!waitsForBots) return;
    let live = true;
    // A failed load counts as loaded without a default id: the chat must not wait forever.
    configService
      .whenReady()
      .catch((error: unknown) => console.warn('[Conversation] settings did not load:', error))
      .finally(() => {
        if (live) setConfigLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [waitsForBots]);
  const scope = data ? previewScopeOfChat(data, storedDefaultAgentId) : null;
  useEffect(() => {
    if (!conversationId || waitsForBots) return;
    const last = lastEnteredRef.current;
    const carryFromScope = last?.conversationId === conversationId ? (last.scope ?? undefined) : undefined;
    lastEnteredRef.current = { conversationId, scope };
    // The WebUI cannot show a webview, so it gets no blank browser tab over the chat.
    enterScopeRef.current(scope, { openBrowserIfEmpty: isElectronDesktop(), carryFromScope, conversationId });
  }, [conversationId, scope, waitsForBots]);

  // Publish the active project SYNCHRONOUSLY on conversation switch, from the
  // in-memory list snapshot (every row carries project_id) — before the async
  // `conversation.get` resolves. Without this the module store held the previous
  // conversation's project until the fetch landed (~120-280ms, seconds when the
  // conversation is cold / mid-backfill), so the Explorer painted the old
  // project's tree. A known conversation publishes its project id immediately
  // (covers never-opened rows — the snapshot is the full list); an unknown one
  // (brand-new / not yet in the snapshot) publishes null — an empty placeholder,
  // never a stale project. Runs before paint (layout effect) so no stale frame.
  useLayoutEffect(() => {
    if (!id) return;
    setCurrentProject(getSnapshotConversationProjectId(id) ?? null);
  }, [id]);

  // Post-resolve authoritative correction: once `conversation.get` lands, publish
  // its project_id (also the backfill path — a workspace conversation's
  // project_id flips None→Some server-side and re-flows here via the refetch
  // below). `setCurrentProject` dedups, so when the sync effect already set the
  // right value this is a no-op.
  useEffect(() => {
    if (data) setCurrentProject(data.project_id ?? null);
  }, [data]);

  // Publish the active conversation id so the Layout-level Explorer's "add to
  // chat" can target this conversation's send box. Cleared when leaving the
  // conversation route (id falsy) so a stale target can't leak.
  useEffect(() => {
    setCurrentConversation(data?.id ?? null);
  }, [data]);

  // Refetch this conversation when the backend reports it changed. This is also
  // the project_id backfill path: opening a workspace conversation lazily
  // backfills its project_id server-side (project_id None→Some), and the first
  // GET can land on the pre-backfill row (project_id null). The backend emits a
  // `conversation.listChanged` (action 'updated') once when the backfill lands;
  // this listener refetches → the now-populated project_id flows to
  // `setCurrentProject` above → the Explorer host appears. Responsive, no poll.
  useEffect(() => {
    if (!id) return;

    return ipcBridge.conversation.listChanged.on((event) => {
      if (event.conversation_id !== id || (event.action !== 'updated' && event.action !== 'created')) {
        return;
      }

      void mutate();
    });
  }, [id, mutate]);

  useEffect(() => {
    if (!data || data.name !== defaultConversationTitle) {
      return;
    }

    void syncTitleFromHistory(data.id);
  }, [data, defaultConversationTitle, syncTitleFromHistory]);

  // 会话不存在（例如从历史栈回到已删除会话）时，提示并替换路由到首页，
  // 避免渲染空骨架。每个 id 只触发一次。
  // Conversation does not exist (e.g. navigating back to a deleted one via
  // browser history): show a toast and replace the route with home, so we
  // don't render an empty skeleton. Fire at most once per id.
  useEffect(() => {
    if (!id || isLoading || data || notFoundHandledIdRef.current === id) return;
    notFoundHandledIdRef.current = id;
    Message.warning(t('conversation.notFound'));
    navigate('/', { replace: true });
  }, [id, isLoading, data, navigate, t]);

  // A chat opened for a hidden Agent (the Butler) goes back to the home page.
  const isHiddenAgentChat = data ? isHiddenAgentId(resolveAssistantConfigId(data)) : false;
  useEffect(() => {
    if (isHiddenAgentChat) navigate('/guid', { replace: true });
  }, [isHiddenAgentChat, navigate]);

  if ((isLoading && !data) || isHiddenAgentChat) {
    return (
      <div className='flex flex-1 items-center justify-center min-h-0'>
        <Spin delay={SPINNER_DELAY_MS} />
      </div>
    );
  }
  return (
    <div
      className='flex flex-col flex-1 min-h-0 min-w-0 h-full'
      // The last chat dims only if the next one is slow, and takes no input meanwhile; the new one undims in.
      style={{
        opacity: showingPrevious ? PREVIOUS_CHAT_OPACITY : 1,
        pointerEvents: showingPrevious ? 'none' : undefined,
        transition: `opacity var(--motion-fast) var(--motion-ease-out) ${showingPrevious ? SPINNER_DELAY_MS : 0}ms`,
      }}
      aria-busy={showingPrevious || undefined}
    >
      <ChatConversation conversation={data ?? undefined}></ChatConversation>
    </div>
  );
};

export default ChatConversationIndex;
