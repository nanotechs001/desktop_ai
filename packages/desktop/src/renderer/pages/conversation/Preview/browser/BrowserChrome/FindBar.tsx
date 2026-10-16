/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@arco-design/web-react';
import type { RefInputType } from '@arco-design/web-react/es/Input/interface';
import { Close, Down, Up } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

const KEY = 'preview.browserChrome.find';

type FindResult = { activeMatchOrdinal: number; matches: number };

export type FindBarProps = {
  webview: Electron.WebviewTag;
  /** Called after the search is cleared; the owner hides the bar. */
  onClose: () => void;
  /** Changes each time the bar is asked for again (Cmd+F while open), to refocus the input. */
  focusToken: number;
};

/** Find-in-page bar for a browser tab's webview. */
const FindBar: React.FC<FindBarProps> = ({ webview, onClose, focusToken }) => {
  const { t } = useTranslation();
  const inputRef = useRef<RefInputType>(null);
  const [text, setText] = useState('');
  const [result, setResult] = useState<FindResult | null>(null);

  useEffect(() => {
    const handleFound = (event: Event) => {
      const { activeMatchOrdinal, matches } = (event as Event & { result: FindResult }).result;
      setResult({ activeMatchOrdinal, matches });
    };
    webview.addEventListener('found-in-page', handleFound);
    return () => {
      webview.removeEventListener('found-in-page', handleFound);
    };
  }, [webview]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.dom?.select();
  }, [focusToken]);

  const handleChange = (value: string) => {
    setText(value);
    if (value) {
      webview.findInPage(value);
      return;
    }
    setResult(null);
    webview.stopFindInPage('clearSelection');
  };

  const findNext = (forward: boolean) => {
    if (text) webview.findInPage(text, forward ? { findNext: true } : { forward: false, findNext: true });
  };

  const close = () => {
    webview.stopFindInPage('clearSelection');
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') close();
    else if (event.key === 'Enter') findNext(!event.shiftKey);
  };

  const status =
    !text || !result
      ? ''
      : result.matches > 0
        ? `${result.activeMatchOrdinal} / ${result.matches}`
        : t(`${KEY}.noMatches`);

  return (
    <div className='flex items-center gap-4px p-6px rd-8px bg-bg-3 b-1 b-solid b-border-2 shadow-md'>
      <Input
        ref={inputRef}
        size='small'
        className='w-200px'
        value={text}
        placeholder={t(`${KEY}.placeholder`)}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
      <span className='min-w-56px text-12px text-t-secondary text-center'>{status}</span>
      <Button
        size='small'
        type='text'
        aria-label={t(`${KEY}.previous`)}
        icon={<Up />}
        onClick={() => findNext(false)}
      />
      <Button size='small' type='text' aria-label={t(`${KEY}.next`)} icon={<Down />} onClick={() => findNext(true)} />
      <Button size='small' type='text' aria-label={t(`${KEY}.close`)} icon={<Close />} onClick={close} />
    </div>
  );
};

export default FindBar;
