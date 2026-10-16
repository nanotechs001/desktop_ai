/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';

/**
 * Get sortOrder from conversation extra
 */
export const getConversationSortOrder = (conversation: TChatConversation): number | undefined => {
  const extra = conversation.extra as { sortOrder?: number } | undefined;
  return extra?.sortOrder;
};
