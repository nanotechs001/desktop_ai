import type { AssistantEditorViewModel, AssistantListItem } from './types';
import { Button, Empty, Tooltip } from '@arco-design/web-react';
import { isUndeletableAgent } from '@/common/types/agent/defaultAgent';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { ArrowLeft } from '@icon-park/react';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import BotColorDot from '@/renderer/components/agent/BotColorDot';
import AssistantEditorSections from './AssistantEditorSections';
import { useAssistantEditorViewModel } from './editor/useAssistantEditorViewModel';
import SkillConfirmModals from './SkillConfirmModals';

type AssistantEditorPageProps = {
  editor: AssistantEditorViewModel;
  activeAssistant: AssistantListItem | null;
  onBack: () => void;
  /** Where deleting cannot work (a robot window: it would navigate away from the robot), Delete is not offered. */
  hideDelete?: boolean;
  /** The back button's label where back does not lead to the agent list. */
  backLabel?: string;
};

const AssistantEditorPage: React.FC<AssistantEditorPageProps> = ({
  editor,
  activeAssistant,
  onBack,
  hideDelete,
  backLabel,
}) => {
  const { t } = useTranslation();
  const { isCreating, actions, profile } = editor;
  const canDelete = !hideDelete && !isCreating && activeAssistant?.source === 'user';
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
            {backLabel ?? t('settings.assistantBackToList', { defaultValue: 'All Agents' })}
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

type EmbeddedAssistantEditorProps = {
  assistantId: string;
  /** Cancel, back, or a save that closes the editor. */
  onBack: () => void;
};

/** One assistant's editor, opened on its own outside the settings page (a robot's expanded window). */
export const EmbeddedAssistantEditor: React.FC<EmbeddedAssistantEditorProps> = ({ assistantId, onBack }) => {
  const { t } = useTranslation();
  const { assistants, activeAssistant, message, messageContext, editor, editorViewModel } =
    useAssistantEditorViewModel();
  // shortcut: an empty list means it is still loading (a loaded list always has the built-in bots); add a loading
  // flag to useAssistantList if that ever stops holding.
  const missing = assistants.length > 0 && !assistants.some((assistant) => assistant.id === assistantId);
  const openedRef = useRef(false);
  const wasVisibleRef = useRef(false);

  useEffect(() => {
    if (openedRef.current) return;
    const target = assistants.find((assistant) => assistant.id === assistantId);
    if (!target) return;
    openedRef.current = true;
    void editor.handleEdit(target);
  }, [assistants, assistantId, editor]);

  // A successful save closes the editor; here that means going back.
  useEffect(() => {
    if (wasVisibleRef.current && !editor.editVisible) onBack();
    wasVisibleRef.current = editor.editVisible;
  }, [editor.editVisible, onBack]);

  return (
    <>
      {messageContext}
      {missing && <Empty className='m-auto' description={t('pet.widget.botMissing')} />}
      {editor.editVisible && (
        <AssistantEditorPage
          editor={editorViewModel}
          activeAssistant={activeAssistant}
          onBack={onBack}
          hideDelete
          backLabel={t('common.back')}
        />
      )}
      <SkillConfirmModals
        deletePendingSkillName={editor.deletePendingSkillName}
        setDeletePendingSkillName={editor.setDeletePendingSkillName}
        pendingSkills={editor.pendingSkills}
        setPendingSkills={editor.setPendingSkills}
        deleteCustomSkillName={editor.deleteCustomSkillName}
        setDeleteCustomSkillName={editor.setDeleteCustomSkillName}
        customSkills={editor.customSkills}
        setCustomSkills={editor.setCustomSkills}
        selectedSkills={editor.selectedSkills}
        setSelectedSkills={editor.setSelectedSkills}
        message={message}
      />
    </>
  );
};

export default AssistantEditorPage;
