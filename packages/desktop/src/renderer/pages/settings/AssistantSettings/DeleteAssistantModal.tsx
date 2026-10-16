/**
 * DeleteAssistantModal — Confirmation modal for deleting an assistant.
 */
import type { AssistantListItem } from './types';
import AssistantAvatar from './AssistantAvatar';
import { Checkbox, Modal } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type DeleteAssistantModalProps = {
  visible: boolean;
  onCancel: () => void;
  /** `deleteBrowserData`: also delete the Agent's browser profile (cookies, sign-ins, site data, extensions). */
  onConfirm: (deleteBrowserData: boolean) => void;
  activeAssistant: AssistantListItem | null;
};

const DeleteAssistantModal: React.FC<DeleteAssistantModalProps> = ({
  visible,
  onCancel,
  onConfirm,
  activeAssistant,
}) => {
  const { t } = useTranslation();
  const [deleteBrowserData, setDeleteBrowserData] = useState(true);

  // Each time the dialog opens it asks afresh, defaulting to delete: a deleted Agent's sign-ins have no use.
  useEffect(() => {
    if (visible) setDeleteBrowserData(true);
  }, [visible]);

  return (
    <Modal
      title={t('settings.deleteAssistantTitle', { defaultValue: 'Delete Agent' })}
      visible={visible}
      onCancel={onCancel}
      onOk={() => onConfirm(deleteBrowserData)}
      okButtonProps={{ status: 'danger' }}
      wrapClassName='delete-assistant-modal'
      data-testid='modal-delete-assistant'
      okText={t('common.delete', { defaultValue: 'Delete' })}
      cancelText={t('common.cancel', { defaultValue: 'Cancel' })}
      className='w-[90vw] md:w-[400px]'
      wrapStyle={{ zIndex: 10000 }}
      maskStyle={{ zIndex: 9999 }}
    >
      <p>
        {t('settings.deleteAssistantConfirm', {
          defaultValue: 'Are you sure you want to delete this Agent? This action cannot be undone.',
        })}
      </p>
      {activeAssistant && (
        <div className='mt-12px p-12px bg-fill-2 rounded-lg flex items-center gap-12px'>
          <AssistantAvatar assistant={activeAssistant} size={32} />
          <div>
            <div className='font-medium'>{activeAssistant.name}</div>
            <div className='text-12px text-t-secondary'>{activeAssistant.description}</div>
          </div>
        </div>
      )}
      <Checkbox className='mt-12px' checked={deleteBrowserData} onChange={setDeleteBrowserData}>
        {t('agent.browserProfile.deleteWithAgent', {
          defaultValue: 'Also delete its browser data (cookies, sign-ins, site data, extensions)',
        })}
      </Checkbox>
    </Modal>
  );
};

export default DeleteAssistantModal;
