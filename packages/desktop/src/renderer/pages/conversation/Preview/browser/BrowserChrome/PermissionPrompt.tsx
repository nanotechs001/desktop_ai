/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Modal } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { PermissionRequest } from '@/common/types/browser';

const KEY = 'preview.browserChrome.permission';

/** i18n key suffix for what a request asks for; `media` says camera, microphone or both. */
const messageKey = ({ permission, mediaTypes }: PermissionRequest): string => {
  switch (permission) {
    case 'media': {
      const video = mediaTypes.includes('video');
      const audio = mediaTypes.includes('audio');
      if (video && !audio) return 'mediaCamera';
      if (audio && !video) return 'mediaMicrophone';
      return 'media';
    }
    case 'geolocation':
    case 'notifications':
      return permission;
    case 'clipboard-read':
      return 'clipboard';
    case 'midi':
    case 'midiSysex':
      return 'midi';
    default:
      return 'other';
  }
};

const PromptBody: React.FC<{ request: PermissionRequest }> = ({ request }) => {
  const { t } = useTranslation();
  const [remember, setRemember] = useState(true);
  const reply = (allow: boolean): void => {
    // A request that timed out meanwhile is already gone from the list, so a failed reply needs no feedback.
    void ipcBridge.browser.replyPermission.invoke({ id: request.id, allow, remember }).catch((): void => undefined);
  };

  return (
    <div className='flex flex-col gap-16px'>
      <div>{t(`${KEY}.${messageKey(request)}`, { origin: request.origin, permission: request.permission })}</div>
      <Checkbox checked={remember} onChange={setRemember}>
        {t(`${KEY}.remember`)}
      </Checkbox>
      <div className='flex justify-end gap-8px'>
        <Button onClick={() => reply(false)}>{t(`${KEY}.block`)}</Button>
        <Button type='primary' onClick={() => reply(true)}>
          {t(`${KEY}.allow`)}
        </Button>
      </div>
    </div>
  );
};

/** Asks the user, one site request at a time (oldest first), to allow or block a browser permission. */
const PermissionPrompt: React.FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState<PermissionRequest[]>([]);
  const gotEvent = useRef(false);

  useEffect(() => {
    const off = ipcBridge.browser.permissionRequested.on((next) => {
      gotEvent.current = true;
      setOpen(next);
    });
    // A prompt raised before mount is still open; an event that arrived first is newer, so it wins.
    void ipcBridge.browser.getPermissionRequests.invoke().then((res) => {
      if (res.success && res.data && !gotEvent.current) setOpen(res.data);
    });
    return off;
  }, []);

  const current = open[0];
  if (!current) return null;

  return (
    <Modal visible title={t(`${KEY}.title`)} footer={null} closable={false} maskClosable={false} escToExit={false}>
      <PromptBody key={current.id} request={current} />
    </Modal>
  );
};

export default PermissionPrompt;
