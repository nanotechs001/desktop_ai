/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button, List, Popover, Progress } from '@arco-design/web-react';
import { Download } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { DownloadItem } from '@/common/types/browser';

const percentOf = (item: DownloadItem): number =>
  item.totalBytes > 0 ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100)) : 0;

const DownloadRow: React.FC<{ item: DownloadItem }> = ({ item }) => {
  const { t } = useTranslation();
  const { id } = item;
  return (
    <List.Item key={id}>
      <div className='flex flex-col gap-4px w-260px'>
        <span className='truncate text-t-primary' title={item.filename}>
          {item.filename}
        </span>
        {item.state === 'progressing' && (
          <div className='flex items-center gap-8px'>
            <Progress className='flex-1' size='small' percent={percentOf(item)} />
            <Button size='mini' onClick={() => void ipcBridge.browser.cancelDownload.invoke({ id })}>
              {t('preview.browserChrome.downloads.cancel')}
            </Button>
          </div>
        )}
        {item.state === 'completed' && (
          <div className='flex gap-8px'>
            <Button size='mini' onClick={() => void ipcBridge.browser.openDownload.invoke({ id })}>
              {t('preview.browserChrome.downloads.open')}
            </Button>
            <Button size='mini' onClick={() => void ipcBridge.browser.showDownloadInFolder.invoke({ id })}>
              {t('preview.browserChrome.downloads.showInFolder')}
            </Button>
          </div>
        )}
        {item.state === 'interrupted' && (
          <span className='text-danger'>{t('preview.browserChrome.downloads.failed')}</span>
        )}
      </div>
    </List.Item>
  );
};

/** Nav-bar button that lists the in-app browser's downloads with progress and open / reveal / cancel actions. */
const DownloadsButton: React.FC = () => {
  const { t } = useTranslation();
  const [items, setItems] = useState<DownloadItem[]>([]);
  const gotEvent = useRef(false);

  useEffect(() => {
    const off = ipcBridge.browser.downloadsChanged.on((next) => {
      gotEvent.current = true;
      setItems(next);
    });
    // A late mount still sees earlier downloads; an event that arrived first is newer, so it wins.
    void ipcBridge.browser.getDownloads.invoke().then((res) => {
      if (res.success && res.data && !gotEvent.current) setItems(res.data);
    });
    return off;
  }, []);

  const content = (
    <div className='max-h-360px overflow-y-auto'>
      <div className='font-bold mb-8px'>{t('preview.browserChrome.downloads.title')}</div>
      {items.length === 0 ? (
        <div className='text-t-secondary'>{t('preview.browserChrome.downloads.empty')}</div>
      ) : (
        <List
          size='small'
          bordered={false}
          dataSource={items.toReversed()}
          render={(item) => <DownloadRow item={item} />}
        />
      )}
    </div>
  );

  return (
    <Popover trigger='click' position='br' content={content}>
      <Button
        type='text'
        size='mini'
        aria-label={t('preview.browserChrome.downloads.title')}
        icon={<Download theme='outline' size='16' />}
      />
    </Popover>
  );
};

export default DownloadsButton;
