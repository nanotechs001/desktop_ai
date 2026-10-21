/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether the home page's prompt holds anything (text or files). Its input is component state, lost on unmount, so
 * code that would navigate away on its own (following a robot's chat) asks first.
 */
let draftPresent = false;

export const setGuidDraftPresent = (present: boolean): void => {
  draftPresent = present;
};

export const hasGuidDraft = (): boolean => draftPresent;
