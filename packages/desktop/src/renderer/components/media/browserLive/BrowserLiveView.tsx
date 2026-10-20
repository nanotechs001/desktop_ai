/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Select } from '@arco-design/web-react';
import type { RefInputType } from '@arco-design/web-react/es/Input/interface';
import { Keyboard } from '@icon-park/react';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { useBrowserLiveStream } from './useBrowserLiveStream';

type LiveTab = { id: string; title: string; url: string; paused: boolean };

type BrowserLiveViewProps = {
  /** Shown instead when there is no conversation, no preview, or the conversation has no tab to watch. */
  fallback: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
};

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TAB_ID = /^wc-\d{1,9}$/;
const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;
const MAX_TEXT_CHARS = 2000;
const MAX_SCROLL_DELTA_PX = 10_000;

const parseTabs = (body: unknown): LiveTab[] => {
  const tabs = (body as { tabs?: unknown } | null)?.tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs.flatMap((tab: Record<string, unknown>) =>
    typeof tab?.id === 'string' && TAB_ID.test(tab.id)
      ? [{ id: tab.id, title: String(tab.title ?? ''), url: String(tab.url ?? ''), paused: tab.paused === true }]
      : []
  );
};

/** Where `object-fit: contain` drew the frame inside the img box; null before a frame. */
const drawnRect = (img: HTMLImageElement): { left: number; top: number; width: number; height: number } | null => {
  const box = img.getBoundingClientRect();
  if (!img.naturalWidth || !img.naturalHeight || !box.width || !box.height) return null;
  const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
  const width = img.naturalWidth * scale;
  const height = img.naturalHeight * scale;
  return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
};

/** A point as a fraction of the drawn frame, or null in the letterbox around it. */
const pointOnFrame = (img: HTMLImageElement, x: number, y: number) => {
  const rect = drawnRect(img);
  if (!rect) return null;
  const nx = (x - rect.left) / rect.width;
  const ny = (y - rect.top) / rect.height;
  return nx < 0 || nx > 1 || ny < 0 || ny > 1 ? null : { nx, ny, height: rect.height };
};

type Gesture = {
  x: number;
  y: number;
  lastY: number;
  at: number;
  scrolling: boolean;
  pendingDy: number;
  frame: number;
};

/**
 * The WebUI's stand-in for `<webview>` in the browser preview: a live picture of the conversation's agent tab on the
 * desktop, streamed over `/api/browser-view/stream`. Taps, vertical swipes and typing go back to that tab.
 */
const BrowserLiveView: React.FC<BrowserLiveViewProps> = ({ fallback, className, style }) => {
  const { t } = useTranslation();
  const preview = useOptionalPreviewContext();
  const conversationId = useCurrentConversation();
  const [tabs, setTabs] = useState<LiveTab[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<RefInputType>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const canWatch = Boolean(preview && conversationId && CONVERSATION_ID.test(conversationId));

  useEffect(() => {
    if (!canWatch || !conversationId) return;
    let live = true;
    setTabs(null);
    fetch(`/api/browser-view/tabs?conversation=${encodeURIComponent(conversationId)}`, { credentials: 'include' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<unknown>;
      })
      .then((body) => {
        if (live) setTabs(parseTabs(body));
      })
      .catch((error: unknown) => {
        console.warn('[BrowserLiveView] could not list the browser tabs:', error);
        if (live) setTabs([]);
      });
    return () => {
      live = false;
    };
  }, [canWatch, conversationId, generation]);

  const listed = tabs?.find((tab) => tab.id === selectedId) ?? tabs?.[0] ?? null;
  const { status, tab, metaRef, send } = useBrowserLiveStream(listed?.id ?? null, imgRef, surfaceRef);
  const shown = tab ?? listed;

  const retry = useCallback(() => setGeneration((count) => count + 1), []);

  const flushScroll = useCallback(() => {
    const gesture = gestureRef.current;
    const img = imgRef.current;
    const meta = metaRef.current;
    if (!gesture || !img || !meta) return;
    gesture.frame = 0;
    const point = pointOnFrame(img, gesture.x, gesture.y);
    if (!point || gesture.pendingDy === 0) return;
    // Phone px over the drawn frame -> page CSS px (the frame spans deviceHeight / pageScaleFactor of them).
    const pageDy = (-gesture.pendingDy / point.height) * (meta.deviceHeight / meta.pageScaleFactor);
    gesture.pendingDy = 0;
    const dy = Math.max(-MAX_SCROLL_DELTA_PX, Math.min(MAX_SCROLL_DELTA_PX, pageDy));
    send({ type: 'scroll', nx: point.nx, ny: point.ny, dy });
  }, [metaRef, send]);

  const handlePointerDown = (event: React.PointerEvent) => {
    const { clientX: x, clientY: y, timeStamp: at } = event;
    gestureRef.current = { x, y, lastY: y, at, scrolling: false, pendingDy: 0, frame: 0 };
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (!gesture.scrolling && Math.abs(event.clientY - gesture.y) > TAP_SLOP_PX) gesture.scrolling = true;
    if (!gesture.scrolling) return;
    gesture.pendingDy += event.clientY - gesture.lastY;
    gesture.lastY = event.clientY;
    if (!gesture.frame) gesture.frame = requestAnimationFrame(flushScroll);
  };

  const handlePointerUp = (event: React.PointerEvent) => {
    const gesture = gestureRef.current;
    if (gesture?.scrolling) flushScroll();
    gestureRef.current = null;
    const img = imgRef.current;
    if (!gesture || !img || gesture.scrolling) return;
    const moved = Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y);
    if (moved > TAP_SLOP_PX || event.timeStamp - gesture.at > TAP_MAX_MS) return;
    const point = pointOnFrame(img, gesture.x, gesture.y);
    if (point) send({ type: 'tap', nx: point.nx, ny: point.ny });
  };

  const handleText = (value: string) => {
    for (let start = 0; start < value.length; start += MAX_TEXT_CHARS) {
      send({ type: 'text', value: value.slice(start, start + MAX_TEXT_CHARS) });
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !event.currentTarget.value) send({ type: 'key', key: 'Backspace' });
  };

  if (!canWatch || tabs?.length === 0) return <>{fallback}</>;

  const statusBar =
    status === 'stopped' ? (
      <Button long onClick={retry}>
        {t('preview.browser.liveStopped')}
      </Button>
    ) : status === 'no-frames' ? (
      <div className='text-13px text-t-secondary text-center'>{t('preview.browser.liveNoFrames')}</div>
    ) : shown?.paused ? (
      <Button long type='primary' onClick={() => send({ type: 'resume' })}>
        {t('preview.browser.livePaused')}
      </Button>
    ) : status === 'connecting' ? (
      <div className='text-13px text-t-secondary text-center'>{t('preview.browser.liveConnecting')}</div>
    ) : null;

  return (
    <div className={`h-full w-full flex flex-col bg-bg-1 ${className ?? ''}`} style={style}>
      <div className='flex items-center gap-8px px-8px py-6px border-0 border-b border-solid border-b-base'>
        <Button size='small' onClick={preview?.closePreview}>
          {t('common.back')}
        </Button>
        <div className='flex-1 min-w-0'>
          {tabs && tabs.length > 1 ? (
            <Select
              size='small'
              value={listed?.id}
              onChange={(id: string) => setSelectedId(id)}
              options={tabs.map((item) => ({ value: item.id, label: item.title || item.url }))}
            />
          ) : (
            <div className='text-13px text-t-primary truncate'>{shown?.title || shown?.url}</div>
          )}
          {shown?.url && <div className='text-11px text-t-secondary truncate'>{shown.url}</div>}
        </div>
        <Button size='small' icon={<Keyboard theme='outline' size='14' />} onClick={() => inputRef.current?.focus()}>
          {t('preview.browser.liveKeyboard')}
        </Button>
      </div>
      {statusBar && <div className='px-8px py-6px'>{statusBar}</div>}
      <div
        ref={surfaceRef}
        role='img'
        aria-label={shown?.title || shown?.url || t('preview.browser.liveConnecting')}
        className='relative flex-1 min-h-0 touch-none select-none'
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => (gestureRef.current = null)}
      >
        <img ref={imgRef} alt='' draggable={false} className='block w-full h-full object-contain' />
      </div>
      <Input
        ref={inputRef}
        className='sr-only'
        value=''
        aria-label={t('preview.browser.liveKeyboard')}
        onChange={handleText}
        onPressEnter={() => send({ type: 'key', key: 'Enter' })}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
};

export default BrowserLiveView;
