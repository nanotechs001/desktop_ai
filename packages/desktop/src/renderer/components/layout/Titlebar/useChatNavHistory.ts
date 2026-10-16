import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { isElectronDesktop } from '@/renderer/utils/platform';
import { isPrimaryApplicationShortcut } from '@/renderer/utils/ui/keyboardShortcuts';

/** Most chats remembered for Back/Forward in one window. */
export const CHAT_NAV_MAX_ENTRIES = 50;

const CHAT_ROUTE = /^\/conversation\/[^/]+/;

type ChatNavState = { stack: readonly string[]; cursor: number };

const EMPTY_STATE: ChatNavState = { stack: [], cursor: -1 };

/** Record a visit to `path`: drops forward entries, skips repeats and keeps the newest entries. */
export const recordChatVisit = (state: ChatNavState, path: string): ChatNavState => {
  if (state.stack[state.cursor] === path) return state;
  const stack = [...state.stack.slice(0, state.cursor + 1), path].slice(-CHAT_NAV_MAX_ENTRIES);
  return { stack, cursor: stack.length - 1 };
};

export type ChatNavHistory = {
  canBack: boolean;
  canForward: boolean;
  back(): void;
  forward(): void;
};

/**
 * Back/Forward over the conversations visited in this window. Other routes (settings,
 * scheduled tasks, ...) never enter the stack; Back from one of them returns to the last chat.
 */
export const useChatNavHistory = (): ChatNavHistory => {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState<ChatNavState>(EMPTY_STATE);
  const currentChatPath = CHAT_ROUTE.test(location.pathname) ? `${location.pathname}${location.search}` : null;

  useEffect(() => {
    if (currentChatPath) setState((prev) => recordChatVisit(prev, currentChatPath));
  }, [currentChatPath]);

  const { stack, cursor } = state;
  const onCursorChat = currentChatPath !== null && stack[cursor] === currentChatPath;
  const backIndex = onCursorChat ? cursor - 1 : cursor;
  const forwardIndex = cursor + 1;

  const goTo = useCallback(
    (index: number) => {
      const target = stack[index];
      if (target === undefined) return;
      setState({ stack, cursor: index });
      // Replace so walking our own stack does not grow the router history.
      void navigate(target, { replace: true });
    },
    [stack, navigate]
  );

  const back = useCallback(() => goTo(backIndex), [goTo, backIndex]);
  const forward = useCallback(() => goTo(forwardIndex), [goTo, forwardIndex]);

  useEffect(() => {
    if (!isElectronDesktop()) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isPrimaryApplicationShortcut(event, { key: '[', targetGuard: 'embedded-editor' })) {
        event.preventDefault();
        back();
      } else if (isPrimaryApplicationShortcut(event, { key: ']', targetGuard: 'embedded-editor' })) {
        event.preventDefault();
        forward();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [back, forward]);

  return useMemo(
    () => ({
      canBack: stack[backIndex] !== undefined,
      canForward: stack[forwardIndex] !== undefined,
      back,
      forward,
    }),
    [stack, backIndex, forwardIndex, back, forward]
  );
};
