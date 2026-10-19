/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isBotColor } from '@/common/types/agent/botColors';
import { useVaBotColor } from '@/renderer/hooks/agent/useBotColor';
import React from 'react';

type BotColorDotProps = {
  /** `#rrggbb`; nothing is drawn without a valid one, so a bad stored value never reaches a style. */
  color?: string;
  size?: number;
  className?: string;
};

/** The small dot that marks a VA Bot's color. Decorative: the bot's name is always shown beside it. */
const BotColorDot: React.FC<BotColorDotProps> = ({ color, size = 8, className }) => {
  if (!isBotColor(color)) return null;
  // The color is data (user-chosen), so it cannot be a utility class.
  return (
    <span
      aria-hidden='true'
      className={`inline-block flex-shrink-0 rd-full ${className ?? ''}`.trim()}
      style={{ backgroundColor: color, width: size, height: size }}
    />
  );
};

/** The dot for an Agent object from any list or chat: drawn for user-made VA Bots only (see `useVaBotColor`). */
export const VaBotColorDot: React.FC<
  Omit<BotColorDotProps, 'color'> & { assistant?: { id?: string; source?: string } | null }
> = ({ assistant, ...rest }) => <BotColorDot color={useVaBotColor(assistant)} {...rest} />;

export default BotColorDot;
