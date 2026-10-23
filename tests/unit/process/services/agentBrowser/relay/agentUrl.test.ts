import { describe, expect, it } from 'vitest';
import { isAgentNavigableUrl, isSamePage, isSameSite } from '@process/services/agentBrowser/relay/agentUrl';

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

describe('isSamePage / isSameSite', () => {
  it('treats a trailing slash and a #fragment as the same page, other paths, queries or hosts as different', () => {
    expect(isSamePage('https://a.test/x/', 'https://a.test/x#top')).toBe(true);
    expect(isSamePage('https://a.test/', 'https://a.test')).toBe(true);
    expect(isSamePage('https://a.test/x?q=1', 'https://a.test/x?q=2')).toBe(false);
    expect(isSamePage('https://a.test/x', 'https://b.test/x')).toBe(false);
  });

  it('counts subdomains of one site as the same site', () => {
    expect(isSameSite('https://app.slack.example.com/c', 'https://slack.example.com/a')).toBe(true);
    expect(isSameSite('https://elsewhere.test/', 'https://slack.example.com/')).toBe(false);
    expect(isSameSite('not a url', 'https://a.test/')).toBe(false);
  });
});
