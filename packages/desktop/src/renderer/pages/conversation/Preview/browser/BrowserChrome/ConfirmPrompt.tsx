/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Modal } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import ConfirmBody, { CONFIRM_KEY } from '@/renderer/pages/conversation/components/AgentConfirmCards/ConfirmBody';
import {
  replyOverIpc,
  useIpcConfirms,
} from '@/renderer/pages/conversation/components/AgentConfirmCards/useAgentConfirms';

/**
 * Asks the user, one at a time (oldest first), to allow or deny a risky agent click or Enter press. The owning chat
 * shows the same ask (AgentConfirmCards); whichever answers first wins and both go away.
 */
const ConfirmPrompt: React.FC = () => {
  const { t } = useTranslation();
  const current = useIpcConfirms()[0];
  if (!current) return null;

  return (
    // Esc, the close button and a mask click all count as Deny.
    <Modal
      visible
      autoFocus={false}
      title={t(`${CONFIRM_KEY}.title`)}
      footer={null}
      onCancel={() => replyOverIpc(current.id, false, false)}
    >
      <ConfirmBody
        key={current.id}
        request={current}
        focusDeny
        onAnswer={(allow, always) => replyOverIpc(current.id, allow, always)}
      />
    </Modal>
  );
};

export default ConfirmPrompt;
