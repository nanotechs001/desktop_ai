/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Modal } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { ConfirmRequest } from '@/common/types/browser';

const KEY = 'preview.browserChrome.confirm';

const reply = (id: string, allow: boolean, alwaysForSite: boolean): void => {
  // A request that timed out or was withdrawn meanwhile is already gone, so a failed reply needs no feedback.
  void ipcBridge.agentBrowser.replyConfirm.invoke({ id, allow, alwaysForSite }).catch((): void => undefined);
};

const PromptBody: React.FC<{ request: ConfirmRequest }> = ({ request }) => {
  const { t } = useTranslation();
  const [always, setAlways] = useState(false);

  return (
    <div className='flex flex-col gap-16px'>
      <div>{t(`${KEY}.message`, { origin: request.origin })}</div>
      {/* The label is the page's own text: shown as plain text, never as markup. */}
      <div className='break-all font-bold'>{request.label}</div>
      <Checkbox checked={always} onChange={setAlways}>
        {t(`${KEY}.always`)}
      </Checkbox>
      <div className='flex justify-end gap-8px'>
        <Button onClick={() => reply(request.id, false, false)}>{t(`${KEY}.deny`)}</Button>
        <Button type='primary' onClick={() => reply(request.id, true, always)}>
          {t(`${KEY}.allow`)}
        </Button>
      </div>
    </div>
  );
};

/** Asks the user, one at a time (oldest first), to allow or deny a risky agent click or Enter press. */
const ConfirmPrompt: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState<ConfirmRequest[]>([]);
  const gotEvent = useRef(false);

  useEffect(() => {
    const off = ipcBridge.agentBrowser.confirmRequested.on((next) => {
      gotEvent.current = true;
      setOpen(next);
    });
    // An ask raised before mount is still open; an event that arrived first is newer, so it wins.
    void ipcBridge.agentBrowser.getConfirmRequests.invoke().then((res) => {
      if (res.success && res.data && !gotEvent.current) setOpen(res.data);
    });
    return off;
  }, []);

  const current = open[0];
  if (!current) return null;

  return (
    // Esc, the close button and a mask click all count as Deny.
    <Modal visible title={t(`${KEY}.title`)} footer={null} onCancel={() => reply(current.id, false, false)}>
      <PromptBody key={current.id} request={current} />
    </Modal>
  );
};

export default ConfirmPrompt;
