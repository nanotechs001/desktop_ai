/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button, Checkbox } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import type { ConfirmRequest } from '@/common/types/browser';

export const CONFIRM_KEY = 'preview.browserChrome.confirm';

/** What every view needs to draw an ask; the phone gets exactly this. */
export type ConfirmAsk = Pick<ConfirmRequest, 'id' | 'origin' | 'frameOrigin' | 'label'>;

/** Allow stays disabled this long after an ask appears, so a click or Enter aimed at the previous one cannot allow it. */
const ARM_DELAY_MS = 500;

type ConfirmBodyProps = {
  request: ConfirmAsk;
  /** `alwaysForSite` is only ever true on an Allow. */
  onAnswer: (allow: boolean, alwaysForSite: boolean) => void;
  /** The modal gives Deny the focus; a card in the chat leaves it in the send box. */
  focusDeny?: boolean;
};

/** The ask itself, shared by the browser pane's modal and the chat cards. Key it by the request id. */
const ConfirmBody: React.FC<ConfirmBodyProps> = ({ request, onAnswer, focusDeny = false }) => {
  const { t } = useTranslation();
  const [always, setAlways] = useState(false);
  const [armed, setArmed] = useState(false);
  const deny = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Enter or Space on a freshly opened dialog must never allow: Deny has the focus, Allow waits.
    if (focusDeny) deny.current?.focus();
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [focusDeny]);

  return (
    <div className='flex flex-col gap-16px'>
      <div>{t(`${CONFIRM_KEY}.message`, { origin: request.origin })}</div>
      {request.frameOrigin === null && <div>{t(`${CONFIRM_KEY}.frameOpaque`)}</div>}
      {request.frameOrigin !== null && request.frameOrigin !== request.origin && (
        <div>{t(`${CONFIRM_KEY}.frame`, { origin: request.frameOrigin })}</div>
      )}
      {/* The label is the page's own text: shown as plain text, never as markup. */}
      <div className='break-all font-bold'>{request.label}</div>
      {/* A sandboxed frame has no origin to remember. */}
      {request.frameOrigin !== null && (
        <Checkbox checked={always} onChange={setAlways}>
          {t(`${CONFIRM_KEY}.always`)}
        </Checkbox>
      )}
      <div className='flex justify-end gap-8px'>
        <Button ref={deny} onClick={() => onAnswer(false, false)}>
          {t(`${CONFIRM_KEY}.deny`)}
        </Button>
        <Button type='primary' disabled={!armed} onClick={() => onAnswer(true, always)}>
          {t(`${CONFIRM_KEY}.allow`)}
        </Button>
      </div>
    </div>
  );
};

export default ConfirmBody;
