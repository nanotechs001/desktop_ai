/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WebUI only. One-shot startup reads (settings, theme, language, fonts...) run
 * before sign-in and fail with 401. AuthProvider fires this once each time a
 * signed-out page becomes signed in, so they can run again without a reload.
 * The desktop app is never signed out, so it never fires there.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function onAuthenticated(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitAuthenticated(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.error('[auth] sign-in listener failed:', error);
    }
  }
}
