/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@arco-design/web-react';
import type { RefInputType } from '@arco-design/web-react/es/Input/interface';
import { Keyboard, OneToOne, ZoomIn, ZoomOut } from '@icon-park/react';
import AgentConfirmCards from '@/renderer/pages/conversation/components/AgentConfirmCards/AgentConfirmCards';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import LiveTabPicker from './LiveTabPicker';
import { MAX_ZOOM, MIN_ZOOM } from './liveViewport';
import { useBrowserLiveStream } from './useBrowserLiveStream';
import { useLiveGestures } from './useLiveGestures';
import { useLiveKeyboard } from './useLiveKeyboard';
import { isWatchableConversation, useLiveTabs } from './useLiveTabs';

type BrowserLiveViewProps = {
  /** Shown instead when there is no conversation, no preview, or the conversation has no tab to watch. */
  fallback: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

/** iOS zooms the page into a focused input whose font is smaller than this. */
const IOS_NO_ZOOM_FONT_PX = 16;
const HIDDEN_INPUT_STYLE: React.CSSProperties = { fontSize: IOS_NO_ZOOM_FONT_PX };

/**
 * The WebUI's stand-in for `<webview>` in the browser preview: a live picture of the conversation's agent tab on the
 * desktop, streamed over `/api/browser-view/stream`. Taps, vertical swipes and typing go back to that tab; the picture
 * can be zoomed and panned on the phone. It follows the tab the agent works in (else its newest) until the user picks one.
 * The chat's browser asks show here too: on a phone the open live view covers the chat that also shows them.
 */
const BrowserLiveView: React.FC<BrowserLiveViewProps> = ({ fallback, className, style }) => {
  const { t } = useTranslation();
  const preview = useOptionalPreviewContext();
  const conversationId = useCurrentConversation();
  /** The tab the user picked; null follows the agent's tab. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<RefInputType>(null);
  const canWatch = Boolean(preview) && isWatchableConversation(conversationId);
  const tabs = useLiveTabs(canWatch ? conversationId : null, generation);

  // The desktop marks the tab the agent acted on last; before any action, the list's last tab is its newest.
  const picked = tabs?.find((tab) => tab.id === pickedId);
  const listed = picked ?? tabs?.find((tab) => tab.active) ?? tabs?.at(-1) ?? null;
  // The keyboard opens when a tap focused a text field of the page, and closes when one lands elsewhere.
  const onFieldFocus = useCallback((editable: boolean) => {
    if (editable) inputRef.current?.focus();
    else inputRef.current?.blur();
  }, []);
  const { status, tab, metaRef, send } = useBrowserLiveStream(listed?.id ?? null, imgRef, surfaceRef, onFieldFocus);
  const shown = tab ?? listed;
  const hasTabs = Boolean(tabs?.length);

  // The picked tab closed: follow the newest again.
  useEffect(() => {
    if (pickedId && tabs && !picked) setPickedId(null);
  }, [pickedId, tabs, picked]);

  const focusKeyboard = useCallback(() => inputRef.current?.focus(), []);
  useLiveKeyboard(inputRef, send, canWatch && hasTabs);
  const { viewport, handlers, zoomIn, zoomOut, resetZoom } = useLiveGestures({
    surfaceRef,
    imgRef,
    metaRef,
    send,
  });
  // Each tab opens unzoomed.
  const listedId = listed?.id ?? null;
  useEffect(() => resetZoom(), [listedId, resetZoom]);

  const retry = useCallback(() => setGeneration((count) => count + 1), []);

  const asks =
    canWatch && isWatchableConversation(conversationId) ? (
      <div className='shrink-0 max-h-40vh overflow-auto px-8px'>
        <AgentConfirmCards conversationId={conversationId} />
      </div>
    ) : null;

  if (!canWatch || tabs?.length === 0) {
    return (
      <>
        {asks}
        {fallback}
      </>
    );
  }

  const statusBar =
    status === 'stopped' ? (
      <Button long onClick={retry}>
        {t('preview.browser.liveStopped')}
      </Button>
    ) : status === 'no-frames' ? (
      <div className='text-13px text-t-secondary text-center'>{t('preview.browser.liveNoFrames')}</div>
    ) : status === 'connecting' ? (
      <div className='text-13px text-t-secondary text-center'>{t('preview.browser.liveConnecting')}</div>
    ) : null;

  const zoomed = viewport.scale > MIN_ZOOM;

  return (
    <div className={`h-full w-full flex flex-col bg-1 ${className ?? ''}`} style={style}>
      <div className='flex items-center gap-8px px-8px py-6px border-0 border-b border-solid border-b-base'>
        <Button size='small' onClick={preview?.closePreview}>
          {t('common.back')}
        </Button>
        <div className='flex-1 min-w-0'>
          <div className='text-13px text-t-primary truncate'>{shown?.title || shown?.url}</div>
          {shown?.url && <div className='text-11px text-t-secondary truncate'>{shown.url}</div>}
        </div>
        <Button size='small' icon={<Keyboard theme='outline' size='14' />} onClick={focusKeyboard}>
          {t('preview.browser.liveKeyboard')}
        </Button>
      </div>
      {asks}
      {tabs && tabs.length > 1 && <LiveTabPicker tabs={tabs} selectedId={listed?.id} onPick={setPickedId} />}
      {statusBar && <div className='px-8px py-6px'>{statusBar}</div>}
      <div className='relative flex-1 min-h-0'>
        <div
          ref={surfaceRef}
          role='img'
          aria-label={shown?.title || shown?.url || t('preview.browser.liveConnecting')}
          className='absolute inset-0 overflow-hidden touch-none select-none'
          {...handlers}
        >
          {/* Zoom transforms the picture only; the stream keeps its size. */}
          <div
            className='absolute inset-0'
            style={{
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
              transformOrigin: '0 0',
            }}
          >
            <img ref={imgRef} alt='' draggable={false} className='block w-full h-full object-contain' />
          </div>
        </div>
        <div className='absolute right-8px bottom-8px flex items-center gap-6px'>
          {zoomed && (
            <Button
              size='small'
              shape='circle'
              aria-label={t('preview.browser.liveZoomReset')}
              icon={<OneToOne theme='outline' size='14' />}
              onClick={resetZoom}
            />
          )}
          <Button
            size='small'
            shape='circle'
            aria-label={t('preview.browser.liveZoomOut')}
            icon={<ZoomOut theme='outline' size='14' />}
            disabled={!zoomed}
            onClick={zoomOut}
          />
          <Button
            size='small'
            shape='circle'
            aria-label={t('preview.browser.liveZoomIn')}
            icon={<ZoomIn theme='outline' size='14' />}
            disabled={viewport.scale >= MAX_ZOOM}
            onClick={zoomIn}
          />
        </div>
      </div>
      {/* Uncontrolled: useLiveKeyboard reads and empties it, so an IME composition is never overwritten. */}
      <Input
        ref={inputRef}
        className='sr-only'
        style={HIDDEN_INPUT_STYLE}
        aria-label={t('preview.browser.liveKeyboard')}
      />
    </div>
  );
};

export default BrowserLiveView;
