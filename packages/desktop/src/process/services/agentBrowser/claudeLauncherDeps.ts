/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpRequest } from '@/common/adapter/httpBridge';
import { showNotification } from '@process/bridge/notificationBridge';
import i18n from '@process/services/i18n';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import type { ClaudeLauncherDeps } from './claudeLauncher';

type AgentOverrides = { command_override?: string; env_override: { name: string; value: string }[] };

const overridesUrl = (id: string): string => `/api/agents/${encodeURIComponent(id)}/overrides`;

/** Backend- and Electron-wired deps for ensureClaudeLauncher. */
export const claudeLauncherDeps: ClaudeLauncherDeps = {
  homeDir: os.homedir(),
  async listAgents() {
    const agents = await httpRequest<ManagedAgent[]>('GET', '/api/agents/management');
    return (agents ?? []).map((a) => ({ id: a.id, backend: a.backend ?? '', source: a.agent_source }));
  },
  getOverrides: (id) => httpRequest<AgentOverrides>('GET', overridesUrl(id)),
  async setOverride(id, cmd) {
    const current = await httpRequest<AgentOverrides>('GET', overridesUrl(id));
    // PUT replaces the whole override, so carry the user's env entries over.
    await httpRequest<ManagedAgent>('PUT', overridesUrl(id), {
      command_override: cmd,
      env_override: current.env_override ?? [],
    });
  },
  async readFile(p) {
    try {
      return await readFile(p, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  async writeFile(p, content, mode) {
    await mkdir(path.dirname(p), { recursive: true });
    // Write-then-rename so a Claude launch never executes a half-written script.
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, content, { mode });
    await chmod(tmp, mode);
    await rename(tmp, p);
  },
  warn(message) {
    console.warn(`[AionUi] ${message}`);
    void showNotification({ title: 'AionUi', body: i18n.t('agent.claudeLauncherSkipped') });
  },
};
