/**
 * DeleteAssistantModal — Warns what deleting an Agent takes with it (with real counts), then confirms.
 */
import type { AssistantListItem } from './types';
import AssistantAvatar from './AssistantAvatar';
import { useDeletePreview } from '@/renderer/hooks/assistant/useDeletePreview';
import { Modal, Spin } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

type DeleteAssistantModalProps = {
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  activeAssistant: AssistantListItem | null;
  /** The delete is running: buttons are disabled and the progress line shows. */
  deleting?: boolean;
  /** Chats removed so far, while that step runs. */
  progress?: { done: number; total: number } | null;
};

const DeleteAssistantModal: React.FC<DeleteAssistantModalProps> = ({
  visible,
  onCancel,
  onConfirm,
  activeAssistant,
  deleting = false,
  progress = null,
}) => {
  const { t } = useTranslation();
  const state = useDeletePreview(activeAssistant?.id, visible);
  const preview = state.status === 'ready' ? state.preview : null;

  return (
    <Modal
      title={t('agent.deleteBot.title', {
        name: activeAssistant?.name ?? '',
        defaultValue: 'Delete "{{name}}"?',
      })}
      visible={visible}
      onCancel={onCancel}
      onOk={onConfirm}
      okButtonProps={{ status: 'danger', disabled: !preview || deleting }}
      cancelButtonProps={{ disabled: deleting }}
      closable={!deleting}
      maskClosable={false}
      escToExit={!deleting}
      wrapClassName='delete-assistant-modal'
      data-testid='modal-delete-assistant'
      okText={t('common.delete', { defaultValue: 'Delete' })}
      cancelText={t('common.cancel', { defaultValue: 'Cancel' })}
      className='w-[90vw] md:w-[400px]'
      wrapStyle={{ zIndex: 10000 }}
      maskStyle={{ zIndex: 9999 }}
    >
      {activeAssistant && (
        <div className='mb-12px p-12px bg-fill-2 rounded-lg flex items-center gap-12px'>
          <AssistantAvatar assistant={activeAssistant} size={32} />
          <div>
            <div className='font-medium'>{activeAssistant.name}</div>
            <div className='text-12px text-t-secondary'>{activeAssistant.description}</div>
          </div>
        </div>
      )}
      {state.status === 'loading' && (
        <div className='flex items-center gap-8px text-t-secondary'>
          <Spin size={14} />
          {t('agent.deleteBot.counting', { defaultValue: 'Checking what it owns…' })}
        </div>
      )}
      {state.status === 'error' && (
        <p className='text-danger'>
          {t('agent.deleteBot.countFailed', {
            defaultValue: "Couldn't check what it owns. Close this and try again.",
          })}
        </p>
      )}
      {preview && (
        <>
          <p className='m-0 mb-4px'>{t('agent.deleteBot.intro', { defaultValue: 'This permanently removes:' })}</p>
          <ul className='list-disc ps-16px m-0'>
            {preview.chats > 0 && (
              <li>
                {t('agent.deleteBot.chats', {
                  count: preview.chats,
                  defaultValue: 'its {{count}} chats, with their messages, files and history',
                })}
              </li>
            )}
            <li>
              {t('agent.deleteBot.browserProfile', {
                defaultValue: 'its browser profile: cookies, sign-ins, site data and extensions',
              })}
            </li>
            <li>{t('agent.deleteBot.notebook', { defaultValue: 'its notebook (what it learned) and its rules' })}</li>
            {preview.tasks > 0 && (
              <li>
                {t('agent.deleteBot.tasks', { count: preview.tasks, defaultValue: 'its {{count}} scheduled tasks' })}
              </li>
            )}
            {preview.hasRobot && <li>{t('agent.deleteBot.robot', { defaultValue: 'its desktop robot' })}</li>}
            {preview.channels.map((platform) => (
              <li key={platform}>
                {t('agent.deleteBot.channel', {
                  platform,
                  defaultValue: 'its {{platform}} connection, which will stop replying until you pick another bot',
                })}
              </li>
            ))}
          </ul>
          <p className='mt-8px mb-0'>
            {t('agent.deleteBot.skillsStay', { defaultValue: 'Skills it saved stay in your skills library.' })}
          </p>
          <p className='mt-4px mb-0'>
            <strong>{t('agent.deleteBot.irreversible', { defaultValue: "This can't be undone." })}</strong>
          </p>
        </>
      )}
      {deleting && (
        <p className='mt-12px mb-0 text-t-secondary'>
          {progress
            ? t('agent.deleteBot.progress', {
                done: progress.done,
                total: progress.total,
                defaultValue: 'Deleting chats {{done}} of {{total}}…',
              })
            : t('agent.deleteBot.working', { defaultValue: 'Deleting…' })}
        </p>
      )}
    </Modal>
  );
};

export default DeleteAssistantModal;
