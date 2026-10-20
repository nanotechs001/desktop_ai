/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { onAuthenticated } from '@renderer/hooks/context/authEvents';

type BootstrapLogger = (message?: unknown, ...optionalParams: unknown[]) => void;

/**
 * Wait for renderer config initialization without coupling app bootstrap to
 * business data prefetches such as `/api/agents`.
 */
export async function bootstrapRendererConfig(logError: BootstrapLogger = console.error): Promise<void> {
  await configService.initialize().catch((err) => {
    logError('Failed to initialize config:', err);
  });
}

// WebUI: the signed-out boot read failed with 401; read the settings again once signed in.
onAuthenticated(() => void bootstrapRendererConfig());
