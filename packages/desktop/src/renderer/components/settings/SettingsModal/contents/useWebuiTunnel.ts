/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { webui, type TunnelStatus } from '@/common/adapter/ipcBridge';
import { Message } from '@arco-design/web-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * State of the WebUI secure link. The main process owns it, so the switch follows
 * `getStatus` on mount and `statusChanged` afterwards; the result of `start`
 * only says whether the call was accepted, never how the attempt ended.
 */
export const useWebuiTunnel = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TunnelStatus>({ state: 'stopped' });
  // `start` resolves only after the attempt settles (a first download can take a while);
  // keep the switch on until then, whatever the status events say in between.
  const [startPending, setStartPending] = useState(false);
  const sawEventRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = webui.tunnel.statusChanged.on((next) => {
      sawEventRef.current = true;
      setStatus(next);
    });
    webui.tunnel.getStatus
      .invoke()
      .then((current) => {
        // An event that arrived while we were asking is newer than this answer.
        if (!cancelled && !sawEventRef.current) setStatus(current);
      })
      .catch((error) => console.error('[WebuiModal] Failed to load secure link status:', error));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const toggle = useCallback(
    async (enabled: boolean) => {
      try {
        if (!enabled) {
          setStartPending(false);
          await webui.tunnel.stop.invoke();
          return;
        }
        setStartPending(true);
        const result = await webui.tunnel.start.invoke();
        if ('code' in result) {
          Message.error(
            result.code === 'webui-off' ? t('settings.webui.tunnelNeedsWebui') : t('settings.webui.operationFailed')
          );
        }
      } catch (error) {
        console.error('[WebuiModal] Secure link toggle failed:', error);
        Message.error(t('settings.webui.operationFailed'));
      } finally {
        if (enabled) setStartPending(false);
      }
    },
    [t]
  );

  return {
    status,
    url: status.state === 'running' ? status.url : null,
    checked: startPending || status.state !== 'stopped',
    toggle,
  };
};
