/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Tooltip } from '@arco-design/web-react';
import { FileExcel, FilePdf, FilePpt, FileText, FileWord, HtmlFive } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnFile } from './toolFilePaths';
import { useOpenTurnFile } from './useOpenTurnFile';

const ICON_SIZE = '14';

const FileTypeIcon: React.FC<{ name: string }> = ({ name }) => {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return <HtmlFive theme='outline' size={ICON_SIZE} />;
    case 'docx':
      return <FileWord theme='outline' size={ICON_SIZE} />;
    case 'pptx':
      return <FilePpt theme='outline' size={ICON_SIZE} />;
    case 'xlsx':
      return <FileExcel theme='outline' size={ICON_SIZE} />;
    case 'pdf':
      return <FilePdf theme='outline' size={ICON_SIZE} />;
    default:
      return <FileText theme='outline' size={ICON_SIZE} />;
  }
};

/**
 * Compact row of chips for the documents (html / docx / pptx / xlsx / pdf / md) the
 * agent created or edited during one turn. Clicking a chip opens the file in the
 * preview pane.
 */
const MessageFileLinks: React.FC<{ files: TurnFile[] }> = ({ files }) => {
  const { t } = useTranslation();
  const openFile = useOpenTurnFile();
  if (files.length === 0) return null;

  return (
    <div className='flex flex-wrap items-center gap-6px' data-testid='message-file-links'>
      <span className='text-12px text-t-secondary'>{t('messages.fileLinks.title')}</span>
      {files.map((file) => (
        <Tooltip
          key={file.key}
          content={
            <div className='flex flex-col'>
              <span>{t('messages.fileLinks.openInPreview')}</span>
              <span className='break-all opacity-80'>{file.path}</span>
            </div>
          }
        >
          <Button
            size='mini'
            type='secondary'
            className='max-w-260px'
            icon={<FileTypeIcon name={file.name} />}
            aria-label={t('messages.fileLinks.openFileAria', { name: file.name })}
            data-testid='message-file-link'
            onClick={() => void openFile(file.path)}
          >
            <span className='truncate'>{file.name}</span>
          </Button>
        </Tooltip>
      ))}
    </div>
  );
};

export default React.memo(MessageFileLinks);
