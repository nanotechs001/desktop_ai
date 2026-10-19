/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * IPC for the WebUI secure link: `webui.tunnel.{getStatus,start,stop}`. Status changes go out on
 * `webui.tunnel.statusChanged` (emitted by the manager in webuiConfig).
 */

import { z } from 'zod';
import { ipcBridge } from '@/common';
import type { TunnelCommandResult } from '@/common/adapter/ipcBridge';
import { webuiTunnel, writeTunnelEnabled } from '@process/utils/webuiConfig';
import { WEBUI_OFF_MESSAGE } from './tunnelManager';

/** start/stop take no payload; void invokes arrive as undefined (JSON drops it), tolerate null and {}. */
const noPayload = z.union([z.undefined(), z.null(), z.object({}).strict()]);

const INVALID: TunnelCommandResult = { success: false, code: 'invalid-args' };

export function initWebuiTunnelIpc(): void {
  ipcBridge.webui.tunnel.getStatus.provider(async () => webuiTunnel.status());

  ipcBridge.webui.tunnel.start.provider(async (payload?: unknown) => {
    if (!noPayload.safeParse(payload).success) return INVALID;
    try {
      await webuiTunnel.start();
    } catch (error) {
      if (error instanceof Error && error.message === WEBUI_OFF_MESSAGE) return { success: false, code: 'webui-off' };
      throw error;
    }
    await writeTunnelEnabled(true);
    return { success: true, status: webuiTunnel.status() };
  });

  ipcBridge.webui.tunnel.stop.provider(async (payload?: unknown) => {
    if (!noPayload.safeParse(payload).success) return INVALID;
    await webuiTunnel.stop();
    await writeTunnelEnabled(false);
    return { success: true, status: webuiTunnel.status() };
  });
}
