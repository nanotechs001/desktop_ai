import { describe, expect, it } from 'vitest';
import { isAgentNavigableUrl } from '@process/services/agentBrowser/relay/agentUrl';

const RELAY_PORT = 4100;
const BACKEND_PORT = 4200;
const ARTIFACT_PORT = 4300;
// The artifact port is deliberately not part of the blocked set.
const blocked = new Set([RELAY_PORT, BACKEND_PORT]);

describe('isAgentNavigableUrl: artifact origin', () => {
  it('allows the artifact origin but still blocks the relay and aioncore ports', () => {
    expect(isAgentNavigableUrl(`http://127.0.0.1:${ARTIFACT_PORT}/a/AAAAAAAAAAAAAAAAAAAAAA`, blocked)).toBe(true);
    expect(isAgentNavigableUrl(`http://127.0.0.1:${ARTIFACT_PORT}/a/AAAAAAAAAAAAAAAAAAAAAA/v/2`, blocked)).toBe(true);
    expect(isAgentNavigableUrl(`http://127.0.0.1:${RELAY_PORT}/a/AAAAAAAAAAAAAAAAAAAAAA`, blocked)).toBe(false);
    expect(isAgentNavigableUrl(`http://127.0.0.1:${BACKEND_PORT}/`, blocked)).toBe(false);
  });
});
