/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Message } from '@arco-design/web-react';
import { useMemo } from 'react';
import { fallbackBotColor } from '@/common/types/agent/botColors';
import { isVaBotAgent } from '@/common/types/agent/defaultAgent';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { useAssistantEditor, useAssistantList } from '@/renderer/hooks/assistant';
import { useDefaultEngine } from '@/renderer/hooks/agent/useDefaultEngine';
import { useManagedAgentRuntimeCatalog } from '@/renderer/hooks/agent/useManagedAgents';
import { buildAssistantEditorBackends, resolveAvatarImageSrc } from '../assistantUtils';
import type { AssistantEditorViewModel } from '../types';

/**
 * The assistant list, the editor state and the view model the editor page renders. Shared by the settings page and
 * the editor embedded in a robot's expanded window.
 */
export const useAssistantEditorViewModel = () => {
  const [message, messageContext] = Message.useMessage({ maxCount: 10 });
  const list = useAssistantList();
  const { assistants, activeAssistant, setActiveAssistantId, loadAssistants, assistantOrder, setAssistantOrder } = list;
  const { localeKey } = list;
  const managedAgentRuntimeCatalog = useManagedAgentRuntimeCatalog();
  const [defaultAgentId] = useConfig('agent.builtinDefaultId');
  const defaultEngine = useDefaultEngine();
  const builtinAvatarOptions = useMemo(
    () =>
      assistants
        .filter((assistant) => assistant.source === 'builtin' && assistant.avatar?.startsWith('/api/assistants/'))
        .map((assistant) => {
          const src = resolveAvatarImageSrc(assistant.avatar);
          if (!src) {
            return null;
          }

          return {
            id: assistant.id,
            label: assistant.name_i18n?.[localeKey] || assistant.name,
            src,
          };
        })
        .filter((option): option is NonNullable<typeof option> => option !== null),
    [assistants, localeKey]
  );
  const editor = useAssistantEditor({
    localeKey,
    activeAssistant,
    setActiveAssistantId,
    loadAssistants,
    assistants,
    assistantOrder,
    setAssistantOrder,
    message,
    defaultEngineId: defaultEngine.agentId,
  });
  const availableBackends = useMemo(
    () => buildAssistantEditorBackends(managedAgentRuntimeCatalog, localeKey, editor.editAgent),
    [editor.editAgent, localeKey, managedAgentRuntimeCatalog]
  );

  // Only a VA Bot has a color: one being created, or a user-made Agent (not built-in, default or CLI entry).
  const editColor =
    editor.isCreating || (activeAssistant?.source === 'user' && isVaBotAgent(activeAssistant, defaultAgentId))
      ? editor.editColor || (activeAssistant ? fallbackBotColor(activeAssistant.id) : undefined)
      : undefined;
  const editAvatarImage = editor.editAvatarPreview || resolveAvatarImageSrc(editor.editAvatar);
  const editorViewModel: AssistantEditorViewModel = {
    isCreating: editor.isCreating,
    profile: {
      name: editor.editName,
      setName: editor.setEditName,
      description: editor.editDescription,
      setDescription: editor.setEditDescription,
      avatar: editor.editAvatar,
      setAvatar: editor.setEditAvatar,
      setAvatarPreview: editor.setEditAvatarPreview,
      avatarImage: editAvatarImage,
      builtinAvatarOptions,
      color: editColor,
      setColor: editor.setEditColor,
    },
    agent: {
      value: editor.editAgent,
      setValue: editor.chooseEngine,
      availableBackends,
      usesDefault: editor.editUsesDefault,
      followDefault: editor.followDefaultEngine,
      defaultEngineName: defaultEngine.agent
        ? defaultEngine.agent.name_i18n?.[localeKey] || defaultEngine.agent.name
        : undefined,
    },
    prompts: {
      text: editor.editRecommendedPromptsText,
      setText: editor.setEditRecommendedPromptsText,
    },
    defaults: {
      model: {
        mode: editor.defaultModelMode,
        setMode: editor.setDefaultModelMode,
        value: editor.defaultModelValue,
        setValue: editor.setDefaultModelValue,
      },
      permission: {
        mode: editor.defaultPermissionMode,
        setMode: editor.setDefaultPermissionMode,
        value: editor.defaultPermissionValue,
        setValue: editor.setDefaultPermissionValue,
      },
      thoughtLevel: {
        mode: editor.defaultThoughtLevelMode,
        setMode: editor.setDefaultThoughtLevelMode,
        value: editor.defaultThoughtLevelValue,
        setValue: editor.setDefaultThoughtLevelValue,
      },
      skills: {
        mode: editor.defaultSkillsMode,
        setMode: editor.setDefaultSkillsMode,
      },
      mcps: {
        mode: editor.defaultMcpMode,
        setMode: editor.setDefaultMcpMode,
        availableServers: editor.availableMcpServers,
        selectedIds: editor.selectedMcpIds,
        setSelectedIds: editor.setSelectedMcpIds,
      },
    },
    rules: {
      content: editor.editContext,
      setContent: editor.setEditContext,
      viewMode: editor.promptViewMode,
      setViewMode: editor.setPromptViewMode,
    },
    skills: {
      availableSkills: editor.availableSkills,
      selectedSkills: editor.selectedSkills,
      setSelectedSkills: editor.setSelectedSkills,
      pendingSkills: editor.pendingSkills,
      setDeletePendingSkillName: editor.setDeletePendingSkillName,
      setDeleteCustomSkillName: editor.setDeleteCustomSkillName,
      builtinAutoSkills: editor.builtinAutoSkills,
      disabledBuiltinSkills: editor.disabledBuiltinSkills,
      setDisabledBuiltinSkills: editor.setDisabledBuiltinSkills,
    },
    actions: {
      save: editor.handleSave,
      requestDelete: editor.handleDeleteClick,
      duplicate: (assistant) => void editor.handleDuplicate(assistant),
    },
  };

  return { ...list, message, messageContext, editor, editorViewModel };
};
