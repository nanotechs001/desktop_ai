/**
 * AssistantSettings — Settings page for managing assistants.
 *
 * Editing permissions by assistant type:
 *
 * | Field          | Builtin | Custom |
 * |----------------|---------|--------|
 * | Save button    |  yes    |  yes   |
 * | Name           |  no     |  yes   |
 * | Description    |  no     |  yes   |
 * | Avatar         |  no     |  yes   |
 * | Main Agent     |  yes    |  yes   |
 * | Prompt editing |  no     |  yes   |
 * | Delete         |  no     |  yes   |
 *
 * Builtin assistants only allow Main Agent plus default model / permission
 * overrides. The full-page editor still renders builtin skills and prompts as
 * read-only so users can inspect what's bundled.
 */
import AssistantEditorPage from './AssistantEditorPage';
import { useAssistantEditorViewModel } from './editor/useAssistantEditorViewModel';
import AssistantHomeTabs from './home/AssistantHomeTabs';
import DeleteAssistantModal from './DeleteAssistantModal';
import SkillConfirmModals from './SkillConfirmModals';
import type { AssistantListItem } from './types';
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

type AssistantNavigationState = {
  openAssistantId?: string;
  openAssistantEditor?: boolean;
};
const OPEN_ASSISTANT_EDITOR_INTENT_KEY = 'guid.openAssistantEditorIntent';

const AssistantSettings: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const navigationState = (location.state as AssistantNavigationState | null) ?? null;

  // Keep the current management surface when returning from the editor. The
  // unified Enabled tab is the default entry point for assistant ordering.
  const [homeTab, setHomeTab] = React.useState<'enabled' | 'mine' | 'official'>('mine');

  // "Chat" on an assistant → open a new conversation with it preselected.
  const handleStartChat = useCallback(
    (assistant: AssistantListItem) => {
      navigate('/guid', { state: { selectedAssistantId: assistant.id } });
    },
    [navigate]
  );

  const {
    message,
    messageContext,
    assistants,
    activeAssistantId,
    setActiveAssistantId,
    activeAssistant,
    reorderEnabledAssistants,
    assistantOrder,
    localeKey,
    editor,
    editorViewModel,
  } = useAssistantEditorViewModel();
  const hasConsumedNavigationIntentRef = useRef(false);
  const showEditor = editor.editVisible && (editor.isCreating || activeAssistantId !== null);

  useEffect(() => {
    if (hasConsumedNavigationIntentRef.current) return;
    const openAssistantFromRoute =
      navigationState?.openAssistantEditor && navigationState.openAssistantId ? navigationState.openAssistantId : null;

    let openAssistantFromSession: string | null = null;
    try {
      const rawIntent = sessionStorage.getItem(OPEN_ASSISTANT_EDITOR_INTENT_KEY);
      if (rawIntent) {
        const parsedIntent = JSON.parse(rawIntent) as { assistantId?: string; openAssistantEditor?: boolean };
        if (parsedIntent.openAssistantEditor && parsedIntent.assistantId) {
          openAssistantFromSession = parsedIntent.assistantId;
        }
      }
    } catch (error) {
      console.error('[AssistantManagement] Failed to parse assistant open intent:', error);
    }

    const targetAssistantId = openAssistantFromRoute ?? openAssistantFromSession;
    if (!targetAssistantId) return;
    if (assistants.length === 0) return;

    const targetAssistant = assistants.find((assistant) => assistant.id === targetAssistantId);
    if (!targetAssistant) return;

    hasConsumedNavigationIntentRef.current = true;
    try {
      sessionStorage.removeItem(OPEN_ASSISTANT_EDITOR_INTENT_KEY);
    } catch (error) {
      console.error('[AssistantManagement] Failed to clear assistant open intent:', error);
    }
    void editor.handleEdit(targetAssistant);
  }, [assistants, editor, navigationState]);

  return (
    <div className='h-full w-full overflow-hidden bg-bg-0'>
      <div className='flex flex-col h-full w-full'>
        {messageContext}
        <div className='flex-1 min-h-0'>
          {showEditor ? (
            <AssistantEditorPage
              editor={editorViewModel}
              activeAssistant={activeAssistant}
              onBack={() => editor.setEditVisible(false)}
            />
          ) : (
            <AssistantHomeTabs
              assistants={assistants}
              assistantOrder={assistantOrder}
              localeKey={localeKey}
              initialTab={homeTab}
              onTabChange={setHomeTab}
              onOpenDetail={(assistant) => {
                setActiveAssistantId(assistant.id);
                void editor.handleEdit(assistant);
              }}
              onOpenSettings={(assistant) => {
                setActiveAssistantId(assistant.id);
                void editor.handleEdit(assistant);
              }}
              onDuplicate={(assistant) => {
                // A duplicate becomes a new user assistant, so return to My
                // Assistants after saving — not the Official tab it came from.
                setHomeTab('mine');
                void editor.handleDuplicate(assistant);
              }}
              onDelete={(assistant) => editor.handleDeleteRequest(assistant)}
              onCreate={() => {
                setHomeTab('mine');
                void editor.handleCreate();
              }}
              onToggleEnabled={(assistant, checked) => void editor.handleToggleEnabled(assistant, checked)}
              onReorderEnabled={async (activeId, overId) => {
                try {
                  await reorderEnabledAssistants(activeId, overId);
                } catch {
                  message.error(t('common.failed', { defaultValue: 'Failed' }));
                }
              }}
              onStartChat={handleStartChat}
            />
          )}

          <DeleteAssistantModal
            visible={editor.deleteConfirmVisible}
            onCancel={() => editor.setDeleteConfirmVisible(false)}
            onConfirm={() => void editor.handleDeleteConfirm()}
            activeAssistant={activeAssistant}
            deleting={editor.deleting}
            progress={editor.deleteProgress}
          />

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
        </div>
      </div>
    </div>
  );
};

export default AssistantSettings;
