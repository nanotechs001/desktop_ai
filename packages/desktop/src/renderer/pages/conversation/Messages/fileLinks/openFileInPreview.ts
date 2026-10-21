/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { localFileRef } from '@/common/types/chatFile';
import type { PreviewContentType } from '@/common/types/office/preview';
import { getCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import type { PreviewMetadata } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { getFileTypeInfo } from '@/renderer/utils/file/fileType';
import { resolvePreviewPayload, upgradeFileRef } from '@/renderer/utils/file/previewPayload';
import { getPathBaseName } from './toolFilePaths';

type OpenPreview = (content: string, type: PreviewContentType, meta?: PreviewMetadata) => unknown;

/**
 * Opens the file at `absolutePath` in the preview pane through the same path the workspace explorer and local-file
 * links use: a file ref (upgraded to a project ref when the file lies in the current project) plus
 * {@link resolvePreviewPayload}, which reads text types and leaves pdf / Office to their own viewers. A file that
 * cannot be read opens the pane's existing "File not found" state instead of failing silently.
 */
export async function openFileInPreview(
  openPreview: OpenPreview,
  absolutePath: string,
  workspace?: string
): Promise<void> {
  const fileName = getPathBaseName(absolutePath);
  const { contentType, editable, language } = getFileTypeInfo(fileName);
  const fileRef = await upgradeFileRef(localFileRef(absolutePath), getCurrentProject());
  const metadata = { title: fileName, file_name: fileName, fileRef, file_path: absolutePath, workspace, language };

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
    console.warn('[openFileInPreview] Could not read file for preview:', error);
    openPreview('', contentType, { ...metadata, editable: false, missingFile: true });
  }
}
