/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { joinPath } from '@/common/chat/chatLib';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { useCallback } from 'react';
import { openFileInPreview } from './openFileInPreview';
import { isAbsolutePath } from './toolFilePaths';

/**
 * Absolute path for a path an agent reported: absolute paths are kept, relative
 * ones are resolved against the conversation workspace. `undefined` when a
 * relative path has no workspace to resolve against.
 */
export const resolveTurnFilePath = (path: string, workspace?: string): string | undefined => {
  if (isAbsolutePath(path)) return path;
  return workspace ? joinPath(workspace, path) : undefined;
};

/**
 * Opens an agent-produced document in the preview pane ({@link openFileInPreview}).
 *
 * Never replaces the active tab (unlike markdown file links): the active tab may be
 * the user's — or the agent's — browser page.
 *
 * @returns `open(path)`, resolving to false when the path could not be resolved or
 * there is no preview pane.
 */
export const useOpenTurnFile = (): ((path: string) => Promise<boolean>) => {
  const preview = useOptionalPreviewContext();
  const workspace = useConversationContextSafe()?.workspace;
  const openPreview = preview?.openPreview;

  return useCallback(
    async (path: string) => {
      if (!openPreview) return false;
      const absolutePath = resolveTurnFilePath(path, workspace);
      if (!absolutePath) return false;
      await openFileInPreview(openPreview, absolutePath, workspace);
      return true;
    },
    [openPreview, workspace]
  );
};
