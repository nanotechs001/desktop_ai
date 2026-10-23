/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { MemoryNoteMeta, MemoryVaultRef } from '@/common/types/agent/memory';
import { useCallback, useEffect, useRef, useState } from 'react';

type VaultSnapshot = { notes: MemoryNoteMeta[]; core: string; ok: boolean };

const readVault = async (vault: MemoryVaultRef): Promise<VaultSnapshot> => {
  const [list, core] = await Promise.all([
    ipcBridge.agentMemory.list.invoke({ vault }).catch((): null => null),
    ipcBridge.agentMemory.getCore.invoke({ vault }).catch((): null => null),
  ]);
  return {
    notes: list?.success ? (list.data ?? []) : [],
    core: core?.success ? (core.data ?? '') : '',
    ok: Boolean(list?.success && core?.success),
  };
};

/**
 * One memory vault as the editor shows it: its notes (null while loading) and core, read again whenever the window
 * comes back into view, since agents save to memory during chats.
 */
export const useMemoryVault = (vault: MemoryVaultRef) => {
  const [notes, setNotes] = useState<MemoryNoteMeta[] | null>(null);
  const [core, setCore] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  // Replies for a vault that is no longer shown are dropped.
  const current = useRef(vault);
  current.current = vault;

  const reload = useCallback(async (): Promise<void> => {
    const snapshot = await readVault(vault);
    if (current.current !== vault) return;
    setNotes(snapshot.notes);
    setCore(snapshot.core);
    setLoadFailed(!snapshot.ok);
  }, [vault]);

  useEffect(() => {
    const reloadWhenVisible = () => {
      if (document.visibilityState === 'visible') void reload();
    };
    setNotes(null);
    setLoadFailed(false);
    void reload();
    window.addEventListener('focus', reloadWhenVisible);
    document.addEventListener('visibilitychange', reloadWhenVisible);
    return () => {
      window.removeEventListener('focus', reloadWhenVisible);
      document.removeEventListener('visibilitychange', reloadWhenVisible);
    };
  }, [reload]);

  return { notes, setNotes, core, setCore, loadFailed, reload };
};
