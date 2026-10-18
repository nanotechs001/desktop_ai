/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { joinPath } from '@/common/chat/chatLib';
import { localFileRef } from '@/common/types/chatFile';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { getCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { getFileTypeInfo } from '@/renderer/utils/file/fileType';
import { resolvePreviewPayload, upgradeFileRef } from '@/renderer/utils/file/previewPayload';
import { useCallback } from 'react';
import { getPathBaseName, isAbsolutePath } from './toolFilePaths';

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
 * Opens an agent-produced document in the preview pane through the same path the
 * workspace explorer and local-file links use: a file ref (upgraded to a project
 * ref when the file lies in the current project) plus {@link resolvePreviewPayload},
 * which reads text types and leaves pdf / Office to their own viewers. A file that
 * cannot be read opens the pane's existing "File not found" state instead of failing
 * silently.
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

      const fileName = getPathBaseName(absolutePath);
      const { contentType, editable, language } = getFileTypeInfo(fileName);
      const fileRef = await upgradeFileRef(localFileRef(absolutePath), getCurrentProject());
      const metadata = {
        title: fileName,
        file_name: fileName,
        fileRef,
        file_path: absolutePath,
        workspace,
        language,
      };

      try {
        const payload = await resolvePreviewPayload(fileRef, contentType);
        openPreview(payload.content, contentType, {
          ...metadata,
          editable: payload.oversized ? false : editable,
          oversized: payload.oversized,
          sizeBytes: payload.sizeBytes,
          thresholdBytes: payload.thresholdBytes,
          lastModified: payload.lastModified,
        });
      } catch (error) {
        console.warn('[useOpenTurnFile] Could not read file for preview:', error);
        openPreview('', contentType, { ...metadata, editable: false, missingFile: true });
      }
      return true;
    },
    [openPreview, workspace]
  );
};
