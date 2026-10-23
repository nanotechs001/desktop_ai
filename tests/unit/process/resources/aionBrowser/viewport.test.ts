/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The viewport tool lets an agent show a tab at a phone/tablet/custom size, e.g. to verify mobile BugHerd notes.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelayClient } from '@process/resources/builtinMcp/aionBrowser/relayClient';
import { createBrowserMcpServer } from '@process/resources/builtinMcp/aionBrowser/tools';
import { FakeRelay } from './fakeRelay';

type ToolReply = { isError?: boolean; content: Array<{ type: string; text?: string }> };

let relay: FakeRelay;
let relayClient: RelayClient;
let client: Client;

beforeEach(async () => {
  relay = await FakeRelay.start();
  relay.on('Target.createTarget', () => ({ targetId: 'wc-7' }));
  relay.on('Target.attachToTarget', () => ({ sessionId: 's1' }));
  relay.on('Emulation.setFocusEmulationEnabled', () => ({}));
  relay.on('Emulation.setDeviceMetricsOverride', () => ({}));
  relay.on('Emulation.clearDeviceMetricsOverride', () => ({}));
  relay.on('Emulation.setTouchEmulationEnabled', () => ({}));
  relayClient = new RelayClient(relay.env, () => 'test-agent');
  const server = createBrowserMcpServer(relayClient);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await client.close();
  relayClient.close();
  await relay.stop();
});

const viewport = async (args: Record<string, unknown>): Promise<ToolReply> =>
  (await client.callTool({ name: 'viewport', arguments: args })) as ToolReply;
const openTab = () => client.callTool({ name: 'tabs', arguments: { action: 'open' } });
const textOf = (reply: ToolReply): string => reply.content.map((part) => part.text ?? '').join('');

describe('viewport tool', () => {
  it('is listed for agents', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('viewport');
  });

  it('mobile preset emulates a 390 px touch phone on the current tab', async () => {
    await openTab();
    const reply = await viewport({ preset: 'mobile' });
    expect(reply.isError).toBeFalsy();
    // Height 0 keeps the pane's own height: a fixed 844 left a gap above the page when the pane was another height.
    expect(JSON.parse(textOf(reply))).toEqual({ viewport: { width: 390, height: 'pane', mobile: true } });
    expect(relay.callsTo('Emulation.setDeviceMetricsOverride')).toEqual([
      { width: 390, height: 0, deviceScaleFactor: 0, mobile: true },
    ]);
    expect(relay.callsTo('Emulation.setTouchEmulationEnabled')).toEqual([{ enabled: true, maxTouchPoints: 5 }]);
  });

  it('a custom wide width is a desktop-style viewport without touch', async () => {
    await openTab();
    const reply = await viewport({ width: 1024 });
    expect(JSON.parse(textOf(reply))).toEqual({ viewport: { width: 1024, height: 'pane', mobile: false } });
    expect(relay.callsTo('Emulation.setDeviceMetricsOverride')).toEqual([
      { width: 1024, height: 0, deviceScaleFactor: 0, mobile: false },
    ]);
    expect(relay.callsTo('Emulation.setTouchEmulationEnabled')).toEqual([{ enabled: false }]);
  });

  it('a custom narrow width is treated as a phone', async () => {
    await openTab();
    await viewport({ width: 414, height: 896 });
    expect(relay.callsTo('Emulation.setDeviceMetricsOverride')).toEqual([
      { width: 414, height: 896, deviceScaleFactor: 0, mobile: true },
    ]);
  });

  it('desktop clears the emulation', async () => {
    await openTab();
    await viewport({ preset: 'mobile' });
    const reply = await viewport({ preset: 'desktop' });
    expect(JSON.parse(textOf(reply))).toEqual({ viewport: 'desktop' });
    expect(relay.callsTo('Emulation.clearDeviceMetricsOverride')).toHaveLength(1);
    expect(relay.callsTo('Emulation.setTouchEmulationEnabled').at(-1)).toEqual({ enabled: false });
  });

  it('asks for a preset or width when given neither, and needs a tab', async () => {
    expect(textOf(await viewport({}))).toContain('No current tab');
    await openTab();
    const reply = await viewport({});
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toContain('needs a preset');
    expect(relay.callsTo('Emulation.setDeviceMetricsOverride')).toEqual([]);
  });
});
