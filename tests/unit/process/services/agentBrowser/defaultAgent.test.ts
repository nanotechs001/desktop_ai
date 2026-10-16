import { describe, expect, it, vi } from 'vitest';
import { BackendHttpError, httpRequest } from '@/common/adapter/httpBridge';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  pickDefaultEngineId,
  type EngineEntry,
} from '@/common/types/agent/defaultAgent';
import {
  backendDefaultAgentDeps,
  ensureDefaultAgent,
  setUpDefaultAgent,
  type DefaultAgentDeps,
} from '@process/services/agentBrowser/defaultAgent';

vi.mock('@/common/adapter/httpBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/adapter/httpBridge')>()),
  httpRequest: vi.fn(),
}));
const httpRequestMock = vi.mocked(httpRequest);

type FakeBackend = {
  deps: DefaultAgentDeps;
  assistants: { id: string; name: string; source: string }[];
  settings: Record<string, string | undefined>;
  createAssistant: ReturnType<typeof vi.fn>;
};

/** An in-memory backend: assistants, client settings and one engine. */
const fakeBackend = (init?: {
  assistants?: { id: string; name: string; source: string }[];
  settings?: Record<string, string | undefined>;
  engines?: EngineEntry[];
  createResult?: 'created' | 'exists';
}): FakeBackend => {
  const assistants = [...(init?.assistants ?? [])];
  const settings = { ...init?.settings };
  const engines = init?.engines ?? [{ id: 'claude', enabled: true, status: 'online', agent_type: 'acp' }];
  const createAssistant = vi.fn(async (request: { id: string; name: string; agent_id: string }) => {
    const result = init?.createResult ?? 'created';
    if (result === 'created') assistants.push({ id: request.id, name: request.name, source: 'user' });
    return result;
  });
  const deps: DefaultAgentDeps = {
    getSetting: async (key) => settings[key],
    setSetting: async (key, value) => {
      settings[key] = value;
    },
    listAssistants: async () => [...assistants],
    listEngines: async () => engines,
    createAssistant,
  };
  return { deps, assistants, settings, createAssistant };
};

describe('ensureDefaultAgent', () => {
  it('creates the "Agent" assistant on the default engine and remembers its id', async () => {
    const backend = fakeBackend({ settings: { 'agent.defaultAgentId': 'claude' } });

    const result = await ensureDefaultAgent(backend.deps);

    expect(result).toEqual({ id: DEFAULT_AGENT_ID, created: true });
    expect(backend.createAssistant).toHaveBeenCalledWith({
      id: DEFAULT_AGENT_ID,
      name: DEFAULT_AGENT_NAME,
      agent_id: 'claude',
    });
    expect(backend.settings['agent.builtinDefaultId']).toBe(DEFAULT_AGENT_ID);
  });

  it('is idempotent across restarts', async () => {
    const backend = fakeBackend();

    await ensureDefaultAgent(backend.deps);
    const second = await ensureDefaultAgent(backend.deps);

    expect(second).toEqual({ id: DEFAULT_AGENT_ID, created: false });
    expect(backend.createAssistant).toHaveBeenCalledTimes(1);
  });

  it('finds the Agent by its stored id even after the user renamed it', async () => {
    const backend = fakeBackend({
      assistants: [{ id: 'kept', name: 'My helper', source: 'user' }],
      settings: { 'agent.builtinDefaultId': 'kept' },
    });

    const result = await ensureDefaultAgent(backend.deps);

    expect(result).toEqual({ id: 'kept', created: false });
    expect(backend.createAssistant).not.toHaveBeenCalled();
  });

  it('falls back to a user assistant named "Agent" and stores its id', async () => {
    const backend = fakeBackend({
      assistants: [
        { id: 'official-agent', name: 'Agent', source: 'builtin' },
        { id: 'mine', name: 'Agent', source: 'user' },
      ],
    });

    const result = await ensureDefaultAgent(backend.deps);

    expect(result).toEqual({ id: 'mine', created: false });
    expect(backend.settings['agent.builtinDefaultId']).toBe('mine');
    expect(backend.createAssistant).not.toHaveBeenCalled();
  });

  it('never adopts a generated or extension assistant that happens to be named "Agent"', async () => {
    const backend = fakeBackend({
      assistants: [
        { id: 'bare:claude', name: 'Agent', source: 'generated' },
        { id: 'ext-agent', name: 'Agent', source: 'extension' },
      ],
    });

    const result = await ensureDefaultAgent(backend.deps);

    expect(result).toEqual({ id: DEFAULT_AGENT_ID, created: true });
  });

  it('adopts by name only while no id is stored: with a stored id that is gone it creates its own', async () => {
    const backend = fakeBackend({
      assistants: [{ id: 'mine', name: 'Agent', source: 'user' }],
      settings: { 'agent.builtinDefaultId': 'gone' },
    });

    const result = await ensureDefaultAgent(backend.deps);

    expect(result).toEqual({ id: DEFAULT_AGENT_ID, created: true });
    expect(backend.settings['agent.builtinDefaultId']).toBe(DEFAULT_AGENT_ID);
  });

  it('creates nothing when the assistant list cannot be read', async () => {
    const backend = fakeBackend();
    backend.deps.listAssistants = async () => {
      throw new Error('backend down');
    };

    await expect(ensureDefaultAgent(backend.deps)).rejects.toThrow('backend down');
    expect(backend.createAssistant).not.toHaveBeenCalled();
    expect(backend.settings['agent.builtinDefaultId']).toBeUndefined();
  });

  it('creates it again when the stored id no longer exists and no name matches', async () => {
    const backend = fakeBackend({ settings: { 'agent.builtinDefaultId': 'gone' } });

    const result = await ensureDefaultAgent(backend.deps);

    expect(result).toEqual({ id: DEFAULT_AGENT_ID, created: true });
    expect(backend.settings['agent.builtinDefaultId']).toBe(DEFAULT_AGENT_ID);
  });

  it('treats a conflicting create as "already there"', async () => {
    const backend = fakeBackend({ createResult: 'exists' });

    const result = await ensureDefaultAgent(backend.deps);

    expect(result).toEqual({ id: DEFAULT_AGENT_ID, created: false });
    expect(backend.settings['agent.builtinDefaultId']).toBe(DEFAULT_AGENT_ID);
  });

  it('skips quietly when there is no engine, so the next start retries', async () => {
    const backend = fakeBackend({ engines: [{ id: 'claude', enabled: false, status: 'online', agent_type: 'acp' }] });

    await expect(ensureDefaultAgent(backend.deps)).resolves.toBeNull();
    expect(backend.createAssistant).not.toHaveBeenCalled();
    expect(backend.settings['agent.builtinDefaultId']).toBeUndefined();
  });
});

describe('pickDefaultEngineId', () => {
  const engine = (id: string, extra: Partial<EngineEntry> = {}): EngineEntry => ({
    id,
    enabled: true,
    status: 'online',
    agent_type: 'acp',
    ...extra,
  });

  it('prefers the stored default while it is enabled', () => {
    expect(pickDefaultEngineId([engine('a'), engine('b')], 'b')).toBe('b');
  });

  it('falls back to the first installed enabled engine', () => {
    const engines = [engine('a', { status: 'missing' }), engine('b', { agent_type: 'gemini' }), engine('c')];
    expect(pickDefaultEngineId(engines, 'gone')).toBe('c');
  });

  it('uses a missing engine only when nothing is installed, and returns null for none', () => {
    expect(pickDefaultEngineId([engine('a', { status: 'missing' })], undefined)).toBe('a');
    expect(pickDefaultEngineId([engine('a', { enabled: false })], undefined)).toBeNull();
  });
});

describe('backendDefaultAgentDeps', () => {
  it('maps a 409 from the create to "exists" and any other failure to a throw', async () => {
    const conflict = new BackendHttpError({ method: 'POST', path: '/api/assistants', status: 409, body: {} });
    const broken = new BackendHttpError({ method: 'POST', path: '/api/assistants', status: 500, body: {} });
    const request = { id: DEFAULT_AGENT_ID, name: 'Agent', agent_id: 'claude' };

    httpRequestMock.mockRejectedValueOnce(conflict);
    await expect(backendDefaultAgentDeps.createAssistant(request)).resolves.toBe('exists');

    httpRequestMock.mockRejectedValueOnce(broken);
    await expect(backendDefaultAgentDeps.createAssistant(request)).rejects.toBe(broken);

    httpRequestMock.mockResolvedValueOnce({});
    await expect(backendDefaultAgentDeps.createAssistant(request)).resolves.toBe('created');
    expect(httpRequestMock).toHaveBeenLastCalledWith('POST', '/api/assistants', request);
  });
});

describe('setUpDefaultAgent', () => {
  const ruleDeps = () => ({
    listAssistants: async () => [],
    readRule: vi.fn(async () => ''),
    writeRule: vi.fn(async () => {}),
  });

  it('creates the Agent, gives it the rule block and tells the renderer its id', async () => {
    const backend = fakeBackend();
    const rules = ruleDeps();
    const notify = vi.fn();

    const result = await setUpDefaultAgent({ deps: backend.deps, ruleDeps: rules, notify });

    expect(result).toEqual({ id: DEFAULT_AGENT_ID, created: true });
    expect(rules.writeRule).toHaveBeenCalledWith(DEFAULT_AGENT_ID, '', expect.stringContaining('aion-browser-rule'));
    expect(notify).toHaveBeenCalledWith(DEFAULT_AGENT_ID);
  });

  it('still tells the renderer when the Agent already exists, and stays silent without an engine', async () => {
    const existing = fakeBackend({
      assistants: [{ id: 'kept', name: 'x', source: 'user' }],
      settings: { 'agent.builtinDefaultId': 'kept' },
    });
    const notify = vi.fn();
    await setUpDefaultAgent({ deps: existing.deps, ruleDeps: ruleDeps(), notify });
    expect(notify).toHaveBeenCalledWith('kept');

    const none = fakeBackend({ engines: [] });
    const silent = vi.fn();
    await expect(setUpDefaultAgent({ deps: none.deps, ruleDeps: ruleDeps(), notify: silent })).resolves.toBeNull();
    expect(silent).not.toHaveBeenCalled();
  });
});
