import type { AssistantEditorViewModel, AssistantListItem } from './types';
import { Button, Tooltip } from '@arco-design/web-react';
import { isUndeletableAgent } from '@/common/types/agent/defaultAgent';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { ArrowLeft } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import BotColorDot from '@/renderer/components/agent/BotColorDot';
import AssistantEditorSections from './AssistantEditorSections';

type AssistantEditorPageProps = {
  editor: AssistantEditorViewModel;
  activeAssistant: AssistantListItem | null;
  onBack: () => void;
};

const AssistantEditorPage: React.FC<AssistantEditorPageProps> = ({ editor, activeAssistant, onBack }) => {
  const { t } = useTranslation();
  const { isCreating, actions, profile } = editor;
  const canDelete = !isCreating && activeAssistant?.source === 'user';
  const canSave = isCreating || Boolean(activeAssistant);
  const [defaultAgentId] = useConfig('agent.builtinDefaultId');
  const isDefaultAgent = Boolean(activeAssistant) && isUndeletableAgent(activeAssistant?.id ?? '', defaultAgentId);

  return (
    <div data-testid='assistant-editor-page' className='flex h-full min-h-0 flex-col overflow-hidden bg-transparent'>
      <div
        data-testid='assistant-editor-bar'
        className='sticky top-0 z-10 flex h-48px flex-shrink-0 items-center gap-12px border-b border-border-2 bg-bg-0 px-18px'
      >
        <div className='flex min-w-0 items-center gap-10px'>
          <Button
            type='text'
            icon={<ArrowLeft size={16} />}
            onClick={onBack}
            data-testid='btn-back-assistant-editor'
            className='!flex !items-center !gap-4px !rounded-8px !px-6px !text-t-primary'
          >
            {t('settings.assistantBackToList', { defaultValue: 'All Agents' })}
          </Button>
          <BotColorDot color={profile.color} />
          <div className='truncate text-14px font-600 text-t-primary'>
            {profile.name.trim() ||
              (isCreating
                ? t('settings.createAssistant', { defaultValue: 'Create Agent' })
                : t('settings.editAssistant', { defaultValue: 'Agent Details' }))}
          </div>
        </div>
        <div className='ms-auto flex items-center gap-8px'>
          {canDelete && (
            <Tooltip
              disabled={!isDefaultAgent}
              content={t('agent.cannotDeleteDefault', { defaultValue: "The default Agent can't be deleted." })}
            >
              <span>
                <Button
                  status='danger'
                  className='!rounded-8px'
                  style={{ backgroundColor: 'rgb(var(--danger-1))' }}
                  onClick={actions.requestDelete}
                  disabled={isDefaultAgent}
                  data-testid='btn-delete-assistant'
                >
                  {t('common.delete', { defaultValue: 'Delete' })}
                </Button>
              </span>
            </Tooltip>
          )}
          <Button onClick={onBack} className='!rounded-8px bg-fill-1' data-testid='btn-cancel-assistant-editor'>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            type='primary'
            onClick={actions.save}
            data-testid='btn-save-assistant'
            className='!rounded-8px'
            disabled={!canSave}
          >
            {isCreating ? t('common.create', { defaultValue: 'Create' }) : t('common.save', { defaultValue: 'Save' })}
          </Button>
        </div>
      </div>

      <div
        data-testid='assistant-editor-body'
        data-editor-popup-root
        className='relative min-h-0 flex-1 overflow-auto px-18px py-18px pb-24px'
      >
        <div className='mx-auto w-full max-w-760px'>
          <AssistantEditorSections editor={editor} activeAssistant={activeAssistant} />
        </div>
      </div>
    </div>
  );
};

export default AssistantEditorPage;
