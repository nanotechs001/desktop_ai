import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { persistEnginePin } from '@/renderer/hooks/agent/useDefaultEngine';
import type { IMcpServer } from '@/common/config/storage';
import type { Assistant, CreateAssistantRequest, UpdateAssistantRequest } from '@/common/types/agent/assistantTypes';
import type { Message } from '@arco-design/web-react';
import type {
  AssistantListItem,
  BuiltinAutoSkill,
  PendingSkill,
  SkillInfo,
} from '@/renderer/pages/settings/AssistantSettings/types';
import { ensureBackendMcpCatalog } from '@/renderer/hooks/mcp/catalog';
import { getSkillImportErrorMessage } from '@/renderer/pages/settings/SkillsSettings/skillImportMessages';
import { isUndeletableAgent } from '@/common/types/agent/defaultAgent';
import { stripBrowserRule } from '@/common/types/agent/managedRuleBlock';
import { emitter } from '@/renderer/utils/emitter';
import { assistantOrderAfterToggle, selectableAssistants } from '@/renderer/utils/model/assistantSelection';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mutate as swrMutate } from 'swr';

type UseAssistantEditorParams = {
  localeKey: string;
  activeAssistant: AssistantListItem | null;
  setActiveAssistantId: (id: string | null) => void;
  loadAssistants: () => Promise<void>;
  assistants: AssistantListItem[];
  assistantOrder: readonly string[];
  setAssistantOrder: (nextOrder: readonly string[]) => Promise<void>;
  message: ReturnType<typeof Message.useMessage>[0];
  /** Default engine id; Agents that follow the default run on it. */
  defaultEngineId?: string | null;
};

type AssistantScalarDefaultMode = 'auto' | 'fixed';
type AssistantSkillsDefaultMode = 'auto' | 'fixed';
type AssistantMcpDefaultMode = 'auto' | 'fixed';

const isBuiltinAssistant = (assistant: Assistant | null | undefined): boolean => assistant?.source === 'builtin';
const isGeneratedAssistant = (assistant: Assistant | null | undefined): boolean => assistant?.source === 'generated';

const resolveLocalizedRecommendedPrompts = (
  detail: Awaited<ReturnType<typeof ipcBridge.assistants.get.invoke>>,
  localeKey: string
): string[] => {
  return (
    detail.prompts.recommended_i18n?.[localeKey] ??
    detail.prompts.recommended_i18n?.['en-US'] ??
    detail.prompts.recommended ??
    []
  );
};

const resolveLocalizedProfileField = (
  baseValue: string | undefined,
  localizedValues: Record<string, string> | undefined,
  localeKey: string,
  fallbackValue = ''
): string => localizedValues?.[localeKey] ?? localizedValues?.['en-US'] ?? baseValue ?? fallbackValue;

const isAutoInjectedBuiltinSkill = (skill: SkillInfo): boolean => skill.source === 'builtin' && skill.is_auto_inject;

const deriveBuiltinAutoSkills = (skills: SkillInfo[]): BuiltinAutoSkill[] =>
  skills.filter(isAutoInjectedBuiltinSkill).map((skill) => ({
    name: skill.name,
    description: skill.description,
  }));

/** Keep `agent.enginePins` in step with the editor's choice, writing only when it changed. */
const syncEnginePin = async (assistantId: string, usesDefault: boolean, engineId: string): Promise<void> => {
  const current = configService.get('agent.enginePins')?.[assistantId];
  if (usesDefault && current) return persistEnginePin(assistantId, null);
  if (!usesDefault && engineId && current !== engineId) return persistEnginePin(assistantId, engineId);
};

/**
 * Manages all assistant editing state and handlers:
 * create, edit, duplicate, save, delete, and toggle enabled.
 */
export const useAssistantEditor = ({
  localeKey,
  activeAssistant,
  setActiveAssistantId,
  loadAssistants,
  assistants,
  assistantOrder,
  setAssistantOrder,
  message,
  defaultEngineId,
}: UseAssistantEditorParams) => {
  const { t } = useTranslation();
  const previousLocaleKeyRef = useRef(localeKey);

  const [editVisible, setEditVisible] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editContext, setEditContext] = useState('');
  const [editAvatar, setEditAvatar] = useState('');
  const [editAvatarPreview, setEditAvatarPreview] = useState<string | undefined>(undefined);
  const [editAgent, setEditAgentState] = useState<string>('');
  // True while the Agent follows the default engine (no pin); `editAgent` is then the engine it will run on.
  const [editUsesDefault, setEditUsesDefault] = useState(true);
  const [editRecommendedPromptsText, setEditRecommendedPromptsText] = useState('');
  const [defaultModelMode, setDefaultModelMode] = useState<AssistantScalarDefaultMode>('auto');
  const [defaultModelValue, setDefaultModelValue] = useState('');
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<AssistantScalarDefaultMode>('auto');
  const [defaultPermissionValue, setDefaultPermissionValue] = useState('');
  const [defaultThoughtLevelMode, setDefaultThoughtLevelMode] = useState<AssistantScalarDefaultMode>('auto');
  const [defaultThoughtLevelValue, setDefaultThoughtLevelValue] = useState('');
  const [defaultSkillsMode, setDefaultSkillsMode] = useState<AssistantSkillsDefaultMode>('fixed');
  const [defaultMcpMode, setDefaultMcpMode] = useState<AssistantMcpDefaultMode>('auto');
  const [availableMcpServers, setAvailableMcpServers] = useState<IMcpServer[]>([]);
  const [selectedMcpIds, setSelectedMcpIds] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const [promptViewMode, setPromptViewMode] = useState<'edit' | 'preview'>('preview');

  const [availableSkills, setAvailableSkills] = useState<SkillInfo[]>([]);
  const [customSkills, setCustomSkills] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [pendingSkills, setPendingSkills] = useState<PendingSkill[]>([]);
  const [deletePendingSkillName, setDeletePendingSkillName] = useState<string | null>(null);
  const [deleteCustomSkillName, setDeleteCustomSkillName] = useState<string | null>(null);

  const [builtinAutoSkills, setBuiltinAutoSkills] = useState<BuiltinAutoSkill[]>([]);
  const [disabledBuiltinSkills, setDisabledBuiltinSkills] = useState<string[]>([]);

  const loadAssistantDetail = useCallback(
    async (assistantId: string) => ipcBridge.assistants.get.invoke({ id: assistantId, locale: localeKey }),
    [localeKey]
  );

  const refreshAssistantCatalog = useCallback(async () => {
    await Promise.all([loadAssistants(), swrMutate('assistants.list')]);
  }, [loadAssistants]);

  const refreshAssistantDetailCaches = useCallback(
    async (assistantId: string | null | undefined) => {
      if (!assistantId) return;
      await swrMutate(`guid.assistant.detail.${assistantId}.${localeKey}`);
    },
    [localeKey]
  );

  const loadEditorResources = useCallback(
    async (assistantId: string) => {
      const [detail, skillsList, mcpServers] = await Promise.all([
        loadAssistantDetail(assistantId),
        ipcBridge.fs.listAvailableSkills.invoke(),
        ensureBackendMcpCatalog().then(({ allServers }) => allServers),
      ]);
      return { detail, skillsList, autoSkills: deriveBuiltinAutoSkills(skillsList), mcpServers };
    },
    [loadAssistantDetail]
  );

  useEffect(() => {
    const localeChanged = previousLocaleKeyRef.current !== localeKey;
    previousLocaleKeyRef.current = localeKey;

    if (!localeChanged || !editVisible || isCreating || activeAssistant?.source !== 'builtin') {
      return;
    }

    let cancelled = false;

    void loadAssistantDetail(activeAssistant.id)
      .then((detail) => {
        if (cancelled) return;

        setEditName(
          resolveLocalizedProfileField(
            detail.profile.name,
            detail.profile.name_i18n,
            localeKey,
            activeAssistant.name_i18n?.[localeKey] || activeAssistant.name || ''
          )
        );
        setEditDescription(
          resolveLocalizedProfileField(
            detail.profile.description,
            detail.profile.description_i18n,
            localeKey,
            activeAssistant.description_i18n?.[localeKey] || activeAssistant.description || ''
          )
        );
        setEditContext(detail.rules.content || '');
        setEditRecommendedPromptsText(resolveLocalizedRecommendedPrompts(detail, localeKey).join('\n'));
      })
      .catch((error) => {
        console.error('Failed to refresh builtin assistant locale data:', error);
      });

    return () => {
      cancelled = true;
    };
  }, [activeAssistant, editVisible, isCreating, loadAssistantDetail, localeKey]);

  const resetSkillEditorState = useCallback(() => {
    setPendingSkills([]);
    setDeletePendingSkillName(null);
    setDeleteCustomSkillName(null);
    setSelectedSkills([]);
    setCustomSkills([]);
    setDisabledBuiltinSkills([]);
  }, []);

  const resetDefaultConfigState = useCallback(() => {
    setEditRecommendedPromptsText('');
    setDefaultModelMode('auto');
    setDefaultModelValue('');
    setDefaultPermissionMode('auto');
    setDefaultPermissionValue('');
    setDefaultThoughtLevelMode('auto');
    setDefaultThoughtLevelValue('');
    setDefaultSkillsMode('fixed');
    setDefaultMcpMode('auto');
    setSelectedMcpIds([]);
  }, []);

  const resetModelAndPermissionDefaults = useCallback(() => {
    setDefaultModelMode('auto');
    setDefaultModelValue('');
    setDefaultPermissionMode('auto');
    setDefaultPermissionValue('');
    setDefaultThoughtLevelMode('auto');
    setDefaultThoughtLevelValue('');
  }, []);

  const setEditAgent = useCallback(
    (nextAgent: string) => {
      if (editAgent === nextAgent) {
        return;
      }

      resetModelAndPermissionDefaults();
      setEditAgentState(nextAgent);
    },
    [editAgent, resetModelAndPermissionDefaults]
  );

  /** Pick a specific engine for this Agent (pins it on save). */
  const chooseEngine = useCallback(
    (engineId: string) => {
      setEditAgent(engineId);
      setEditUsesDefault(false);
    },
    [setEditAgent]
  );

  /** Go back to following the default engine (clears the pin on save). */
  const followDefaultEngine = useCallback(() => {
    setEditUsesDefault(true);
    if (defaultEngineId) setEditAgent(defaultEngineId);
  }, [defaultEngineId, setEditAgent]);

  const handleEdit = async (assistant: AssistantListItem) => {
    setIsCreating(false);
    setActiveAssistantId(assistant.id);
    setEditVisible(true);
    setPromptViewMode(isBuiltinAssistant(assistant) ? 'preview' : 'edit');
    setEditName(assistant.name || '');
    setEditDescription(assistant.description || '');
    setEditAvatar(assistant.avatar || '');
    setEditAvatarPreview(undefined);
    setEditAgent(assistant.agent_id || '');
    // A generated (bare CLI) Agent is the engine itself: it never follows the default.
    setEditUsesDefault(!isGeneratedAssistant(assistant) && !configService.get('agent.enginePins')?.[assistant.id]);
    resetDefaultConfigState();
    resetSkillEditorState();

    try {
      const { detail, skillsList, autoSkills, mcpServers } = await loadEditorResources(assistant.id);
      setEditName(
        resolveLocalizedProfileField(detail.profile.name, detail.profile.name_i18n, localeKey, assistant.name || '')
      );
      setEditDescription(
        resolveLocalizedProfileField(
          detail.profile.description,
          detail.profile.description_i18n,
          localeKey,
          assistant.description || ''
        )
      );
      setEditAvatar(detail.profile.avatar || '');
      setEditAvatarPreview(undefined);
      setEditAgent(detail.engine.agent_id || assistant.agent_id || '');
      setEditContext(stripBrowserRule(detail.rules.content || ''));
      setEditRecommendedPromptsText(resolveLocalizedRecommendedPrompts(detail, localeKey).join('\n'));
      setDefaultModelMode(detail.defaults.model.mode === 'fixed' ? 'fixed' : 'auto');
      setDefaultModelValue(detail.defaults.model.value || '');
      setDefaultPermissionMode(detail.defaults.permission.mode === 'fixed' ? 'fixed' : 'auto');
      setDefaultPermissionValue(detail.defaults.permission.value || '');
      setDefaultThoughtLevelMode(detail.defaults.thought_level.mode === 'fixed' ? 'fixed' : 'auto');
      setDefaultThoughtLevelValue(detail.defaults.thought_level.value || '');
      setDefaultSkillsMode(detail.defaults.skills.mode === 'auto' ? 'auto' : 'fixed');
      setDefaultMcpMode(detail.defaults.mcps.mode === 'fixed' ? 'fixed' : 'auto');
      setSelectedMcpIds(detail.defaults.mcps.value ?? []);
      setAvailableSkills(skillsList);
      setBuiltinAutoSkills(autoSkills);
      setAvailableMcpServers(mcpServers);
      setSelectedSkills(detail.capabilities.default_skill_ids ?? []);
      setCustomSkills(isBuiltinAssistant(assistant) ? [] : (detail.capabilities.custom_skill_names ?? []));
      setDisabledBuiltinSkills(detail.capabilities.default_disabled_builtin_skill_ids ?? []);
    } catch (error) {
      console.error('Failed to load assistant detail:', error);
      setEditContext('');
      resetDefaultConfigState();
      setAvailableSkills([]);
      setBuiltinAutoSkills([]);
      setAvailableMcpServers([]);
      resetSkillEditorState();
    }
  };

  const handleCreate = async () => {
    setIsCreating(true);
    setActiveAssistantId(null);
    setEditVisible(true);
    setPromptViewMode('edit');
    setEditName('');
    setEditDescription('');
    setEditContext('');
    setEditAvatar('\u{1F916}');
    setEditAvatarPreview(undefined);
    setEditAgent(defaultEngineId ?? '');
    setEditUsesDefault(true);
    resetDefaultConfigState();
    resetSkillEditorState();

    try {
      const [skillsList, mcpServers] = await Promise.all([
        ipcBridge.fs.listAvailableSkills.invoke(),
        ensureBackendMcpCatalog().then(({ allServers }) => allServers),
      ]);
      setAvailableSkills(skillsList);
      setBuiltinAutoSkills(deriveBuiltinAutoSkills(skillsList));
      setAvailableMcpServers(mcpServers);
    } catch (error) {
      console.error('Failed to load skills:', error);
      setAvailableSkills([]);
      setBuiltinAutoSkills([]);
      setAvailableMcpServers([]);
    }
  };

  const handleDuplicate = async (assistant: AssistantListItem) => {
    setIsCreating(true);
    setActiveAssistantId(null);
    setEditVisible(true);
    setPromptViewMode('edit');
    setEditName(`${assistant.name_i18n?.[localeKey] || assistant.name} (Copy)`);
    setEditDescription(assistant.description_i18n?.[localeKey] || assistant.description || '');
    setEditAvatar(assistant.avatar || '\u{1F916}');
    setEditAvatarPreview(undefined);
    // A copy of a pinned or bare CLI Agent stays on that engine; any other copy follows the default.
    const keepsEngine =
      isGeneratedAssistant(assistant) || Boolean(configService.get('agent.enginePins')?.[assistant.id]);
    setEditAgent((!keepsEngine && defaultEngineId) || assistant.agent_id || '');
    setEditUsesDefault(!keepsEngine);
    resetDefaultConfigState();
    resetSkillEditorState();

    try {
      const { detail, skillsList, autoSkills, mcpServers } = await loadEditorResources(assistant.id);
      setEditContext(stripBrowserRule(detail.rules.content || ''));
      setEditRecommendedPromptsText(resolveLocalizedRecommendedPrompts(detail, localeKey).join('\n'));
      setDefaultModelMode(detail.defaults.model.mode === 'fixed' ? 'fixed' : 'auto');
      setDefaultModelValue(detail.defaults.model.value || '');
      setDefaultPermissionMode(detail.defaults.permission.mode === 'fixed' ? 'fixed' : 'auto');
      setDefaultPermissionValue(detail.defaults.permission.value || '');
      setDefaultThoughtLevelMode(detail.defaults.thought_level.mode === 'fixed' ? 'fixed' : 'auto');
      setDefaultThoughtLevelValue(detail.defaults.thought_level.value || '');
      setDefaultSkillsMode(detail.defaults.skills.mode === 'auto' ? 'auto' : 'fixed');
      setDefaultMcpMode(detail.defaults.mcps.mode === 'fixed' ? 'fixed' : 'auto');
      setSelectedMcpIds(detail.defaults.mcps.value ?? []);
      setAvailableSkills(skillsList);
      setBuiltinAutoSkills(autoSkills);
      setAvailableMcpServers(mcpServers);
      setSelectedSkills(detail.capabilities.default_skill_ids ?? []);
      setCustomSkills(detail.capabilities.custom_skill_names ?? []);
      setDisabledBuiltinSkills(detail.capabilities.default_disabled_builtin_skill_ids ?? []);
    } catch (error) {
      console.error('Failed to load assistant content for duplication:', error);
      setEditContext('');
      resetDefaultConfigState();
      setAvailableSkills([]);
      setBuiltinAutoSkills([]);
      setAvailableMcpServers([]);
      resetSkillEditorState();
    }
  };

  /**
   * Save the user's rule text through main, which adds the AionUi blocks (browser, notebook) and writes the rule in
   * its per-Agent queue, so a note being saved at the same moment can't overwrite the text. Throws when the text
   * wasn't saved; broken block markers save the text as typed and ask the user to fix them. False (with its own
   * message shown) when the text is over main's size cap and nothing was saved.
   */
  const persistAssistantRules = useCallback(
    async (assistantId: string, rules: string): Promise<boolean> => {
      const reply = await ipcBridge.agentBrowser.ensureAgentRule.invoke({
        assistantId,
        locale: localeKey,
        content: rules.trim() ? rules : '',
      });
      if (reply.success) return true;
      if (reply.data && 'tooLong' in reply.data) {
        message.error(t('agent.ruleTooLong', { defaultValue: 'These instructions are too long' }));
        return false;
      }
      if (!reply.data || !('unbalanced' in reply.data)) throw new Error(reply.msg ?? 'Could not save the Agent rule');
      message.warning(
        t('agent.ruleMarkersBroken', { defaultValue: "Fix the AionUi block markers in this Agent's instructions." })
      );
      return true;
    },
    [localeKey, message, t]
  );

  const handleSave = async () => {
    try {
      if (!editName.trim()) {
        message.error(t('settings.assistantNameRequired', { defaultValue: 'Agent name is required' }));
        return;
      }

      if (defaultModelMode === 'fixed' && !defaultModelValue.trim()) {
        message.error(
          t('settings.assistantDefaultModelRequired', {
            defaultValue: 'Please choose a default model when using a fixed value.',
          })
        );
        return;
      }

      if (defaultPermissionMode === 'fixed' && !defaultPermissionValue.trim()) {
        message.error(
          t('settings.assistantDefaultPermissionRequired', {
            defaultValue: 'Please choose a default permission when using a fixed value.',
          })
        );
        return;
      }

      if (defaultThoughtLevelMode === 'fixed' && !defaultThoughtLevelValue.trim()) {
        message.error(
          t('settings.assistantDefaultThoughtLevelRequired', {
            defaultValue: 'Please choose a default thought level when using a fixed value.',
          })
        );
        return;
      }

      if (pendingSkills.length > 0) {
        const skillsToImport = pendingSkills.filter(
          (pending) => !availableSkills.some((available) => available.name === pending.name)
        );

        for (const pendingSkill of skillsToImport) {
          try {
            await ipcBridge.fs.importSkills.invoke({ skill_path: pendingSkill.path });
          } catch (error) {
            console.error(`Failed to import skill "${pendingSkill.name}":`, error);
            message.error(getSkillImportErrorMessage(error, t));
            return;
          }
        }

        if (skillsToImport.length > 0) {
          const skillsList = await ipcBridge.fs.listAvailableSkills.invoke();
          setAvailableSkills(skillsList);
        }
      }

      // An Agent that follows the default runs on the default engine; a pinned one on its own choice.
      const engineId = editUsesDefault ? defaultEngineId || editAgent : editAgent;
      const pendingSkillNames = pendingSkills.map((skill) => skill.name);
      const finalCustomSkills = Array.from(new Set([...customSkills, ...pendingSkillNames]));
      const recommendedPrompts = editRecommendedPromptsText
        .split('\n')
        .map((prompt) => prompt.trim())
        .filter(Boolean);
      const defaults = {
        model:
          defaultModelMode === 'fixed'
            ? { mode: 'fixed', value: defaultModelValue.trim() }
            : { mode: defaultModelMode },
        permission:
          defaultPermissionMode === 'fixed'
            ? { mode: 'fixed', value: defaultPermissionValue.trim() }
            : { mode: defaultPermissionMode },
        thought_level:
          defaultThoughtLevelMode === 'fixed'
            ? { mode: 'fixed', value: defaultThoughtLevelValue.trim() }
            : { mode: defaultThoughtLevelMode },
        skills: { mode: defaultSkillsMode, value: selectedSkills },
        mcps: { mode: defaultMcpMode, value: selectedMcpIds },
      };

      if (isCreating) {
        const createRequest: CreateAssistantRequest = {
          name: editName,
          description: editDescription || undefined,
          avatar: editAvatar || undefined,
          agent_id: engineId || undefined,
          enabled_skills: selectedSkills,
          custom_skill_names: finalCustomSkills,
          disabled_builtin_skills: disabledBuiltinSkills.length > 0 ? disabledBuiltinSkills : undefined,
          recommended_prompts: recommendedPrompts,
          defaults,
        };
        const created = await ipcBridge.assistants.create.invoke(createRequest);
        // The Agent exists from here on: if a step below fails, Save again updates it instead of creating another.
        setIsCreating(false);
        setActiveAssistantId(created.id);
        await refreshAssistantCatalog();
        if (!(await persistAssistantRules(created.id, editContext))) return;
        await syncEnginePin(created.id, editUsesDefault, engineId);
        message.success(t('common.createSuccess', { defaultValue: 'Created successfully' }));
      } else {
        if (!activeAssistant) return;

        let updateRequest: UpdateAssistantRequest;
        if (isBuiltinAssistant(activeAssistant)) {
          updateRequest = {
            id: activeAssistant.id,
            agent_id: engineId || undefined,
            defaults: {
              model:
                defaultModelMode === 'fixed'
                  ? { mode: 'fixed', value: defaultModelValue.trim() }
                  : { mode: defaultModelMode },
              permission:
                defaultPermissionMode === 'fixed'
                  ? { mode: 'fixed', value: defaultPermissionValue.trim() }
                  : { mode: defaultPermissionMode },
              thought_level:
                defaultThoughtLevelMode === 'fixed'
                  ? { mode: 'fixed', value: defaultThoughtLevelValue.trim() }
                  : { mode: defaultThoughtLevelMode },
            },
          };
        } else if (isGeneratedAssistant(activeAssistant)) {
          updateRequest = {
            id: activeAssistant.id,
            description: editDescription || undefined,
            enabled_skills: selectedSkills,
            custom_skill_names: finalCustomSkills,
            disabled_builtin_skills: disabledBuiltinSkills.length > 0 ? disabledBuiltinSkills : undefined,
            recommended_prompts: recommendedPrompts,
            defaults,
          };
        } else {
          updateRequest = {
            id: activeAssistant.id,
            name: editName,
            description: editDescription || undefined,
            avatar: editAvatar || undefined,
            agent_id: engineId || undefined,
            enabled_skills: selectedSkills,
            custom_skill_names: finalCustomSkills,
            disabled_builtin_skills: disabledBuiltinSkills.length > 0 ? disabledBuiltinSkills : undefined,
            recommended_prompts: recommendedPrompts,
            defaults,
          };
        }
        await ipcBridge.assistants.update.invoke(updateRequest);
        if (!isGeneratedAssistant(activeAssistant)) {
          await syncEnginePin(activeAssistant.id, editUsesDefault, engineId);
        }

        if (!isBuiltinAssistant(activeAssistant) && !(await persistAssistantRules(activeAssistant.id, editContext))) {
          return;
        }

        await refreshAssistantCatalog();
        await refreshAssistantDetailCaches(activeAssistant.id);
        emitter.emit('chat.history.refresh');
        message.success(t('common.saveSuccess', { defaultValue: 'Saved successfully' }));
      }

      setEditVisible(false);
      setPendingSkills([]);
    } catch (error) {
      console.error('Failed to save assistant:', error);
      message.error(t('common.failed', { defaultValue: 'Failed' }));
    }
  };

  /** The default Agent always exists; say so instead of opening the confirm dialog. */
  const refuseDefaultAgentDelete = (assistantId: string): boolean => {
    if (!isUndeletableAgent(assistantId, configService.get('agent.builtinDefaultId'))) return false;
    message.warning(t('agent.cannotDeleteDefault', { defaultValue: "The default Agent can't be deleted." }));
    return true;
  };

  const handleDeleteClick = () => {
    if (!activeAssistant || refuseDefaultAgentDelete(activeAssistant.id)) return;

    if (activeAssistant?.source !== 'user') {
      message.warning(t('settings.cannotDeleteBuiltin', { defaultValue: 'Cannot delete builtin Agents' }));
      return;
    }

    setDeleteConfirmVisible(true);
  };

  const handleDeleteRequest = (assistant: AssistantListItem) => {
    setActiveAssistantId(assistant.id);
    if (refuseDefaultAgentDelete(assistant.id)) return;

    if (assistant.source !== 'user') {
      message.warning(t('settings.cannotDeleteBuiltin', { defaultValue: 'Cannot delete builtin Agents' }));
      return;
    }

    setDeleteConfirmVisible(true);
  };

  /**
   * Deletes the Agent, its browser profile first when asked: if that fails the Agent stays, so nothing is left
   * orphaned, and the user is told.
   */
  const handleDeleteConfirm = async (deleteBrowserData = false) => {
    if (!activeAssistant) return;

    try {
      if (deleteBrowserData) {
        const reply = await ipcBridge.browser.deleteProfileData
          .invoke({ agentId: activeAssistant.id })
          .catch((error: unknown) => ({ success: false, msg: error instanceof Error ? error.message : String(error) }));
        if (!reply.success) {
          console.warn('[useAssistantEditor] could not delete the Agent browser data:', reply.msg);
          message.error(
            t('agent.browserProfile.deleteFailed', {
              defaultValue: "Couldn't delete this Agent's browser data, so the Agent was kept. Try again.",
            })
          );
          return;
        }
      }
      await ipcBridge.assistants.delete.invoke({ id: activeAssistant.id });
      await refreshAssistantCatalog();
      setDeleteConfirmVisible(false);
      setEditVisible(false);
      message.success(t('common.success', { defaultValue: 'Success' }));
    } catch (error) {
      console.error('Failed to delete assistant:', error);
      message.error(t('common.failed', { defaultValue: 'Failed' }));
    }
  };

  const handleToggleEnabled = async (assistant: AssistantListItem, enabled: boolean) => {
    const previousOrder = selectableAssistants(assistants, assistantOrder).map((item) => item.id);
    const nextOrder = assistantOrderAfterToggle(assistants, assistantOrder, assistant.id, enabled);
    let orderPersisted = false;

    try {
      await swrMutate(
        'assistants.list',
        (previousAssistants: Assistant[] | undefined) =>
          previousAssistants?.map((existingAssistant) =>
            existingAssistant.id === assistant.id ? { ...existingAssistant, enabled } : existingAssistant
          ),
        { revalidate: false }
      );
      await setAssistantOrder(nextOrder);
      orderPersisted = true;
      await ipcBridge.assistants.setState.invoke({ id: assistant.id, enabled });
      await refreshAssistantCatalog();
      await refreshAssistantDetailCaches(assistant.id);
    } catch (error) {
      console.error('Failed to toggle assistant:', error);
      if (orderPersisted) {
        try {
          await setAssistantOrder(previousOrder);
        } catch (rollbackError) {
          console.error('Failed to restore assistant order after toggle failure:', rollbackError);
        }
      }
      await swrMutate('assistants.list');
      message.error(t('common.failed', { defaultValue: 'Failed' }));
    }
  };

  return {
    editVisible,
    setEditVisible,
    editName,
    setEditName,
    editDescription,
    setEditDescription,
    editContext,
    setEditContext,
    editAvatar,
    setEditAvatar,
    editAvatarPreview,
    setEditAvatarPreview,
    editAgent,
    setEditAgent,
    editUsesDefault,
    chooseEngine,
    followDefaultEngine,
    editRecommendedPromptsText,
    setEditRecommendedPromptsText,
    defaultModelMode,
    setDefaultModelMode,
    defaultModelValue,
    setDefaultModelValue,
    defaultPermissionMode,
    setDefaultPermissionMode,
    defaultPermissionValue,
    setDefaultPermissionValue,
    defaultThoughtLevelMode,
    setDefaultThoughtLevelMode,
    defaultThoughtLevelValue,
    setDefaultThoughtLevelValue,
    defaultSkillsMode,
    setDefaultSkillsMode,
    defaultMcpMode,
    setDefaultMcpMode,
    availableMcpServers,
    selectedMcpIds,
    setSelectedMcpIds,
    isCreating,
    deleteConfirmVisible,
    setDeleteConfirmVisible,
    promptViewMode,
    setPromptViewMode,
    availableSkills,
    setAvailableSkills,
    customSkills,
    setCustomSkills,
    selectedSkills,
    setSelectedSkills,
    pendingSkills,
    setPendingSkills,
    deletePendingSkillName,
    setDeletePendingSkillName,
    deleteCustomSkillName,
    setDeleteCustomSkillName,
    builtinAutoSkills,
    disabledBuiltinSkills,
    setDisabledBuiltinSkills,
    handleEdit,
    handleCreate,
    handleDuplicate,
    handleSave,
    handleDeleteClick,
    handleDeleteRequest,
    handleDeleteConfirm,
    handleToggleEnabled,
  };
};
