import { DEPRECATED_ENGINE_TYPES } from '@/common/types/agent/defaultAgent';

export function isDeprecatedRuntimeAgentType(agentType?: string | null): boolean {
  return Boolean(agentType && DEPRECATED_ENGINE_TYPES.has(agentType));
}

export function resolveSupportedConversationType(backend?: string | null): 'acp' | 'aionrs' {
  return backend === 'aionrs' ? 'aionrs' : 'acp';
}
