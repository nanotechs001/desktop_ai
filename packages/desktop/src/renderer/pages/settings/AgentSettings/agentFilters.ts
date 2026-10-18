import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

export type AgentAvailabilityFilter = 'available' | 'unavailable';

const isAgentAvailable = (agent: ManagedAgent): boolean => agent.status === 'online';

/**
 * The CLI built into the app (internal aionrs engine). It ships with the app and is always available, so the
 * Engine page does not list it; it stays the default engine wherever engines are resolved.
 */
export const isBuiltinAionCli = (agent: Pick<ManagedAgent, 'agent_type' | 'agent_source'>): boolean =>
  agent.agent_type === 'aionrs' && agent.agent_source === 'internal';

export const getAgentAvailabilityFilterStats = (agents: ManagedAgent[]) => ({
  available: agents.filter(isAgentAvailable).length,
  unavailable: agents.filter((agent) => !isAgentAvailable(agent)).length,
});

export const filterAgentsByAvailability = (agents: ManagedAgent[], filter: AgentAvailabilityFilter): ManagedAgent[] =>
  filter === 'available' ? agents.filter(isAgentAvailable) : agents.filter((agent) => !isAgentAvailable(agent));
