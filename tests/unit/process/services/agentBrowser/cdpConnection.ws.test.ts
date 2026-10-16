/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { CdpConnection, createWebSocketTransport } from '@process/services/agentBrowser/cdpConnection';

const servers: WebSocketServer[] = [];
const sockets: WebSocket[] = [];

/** A ws pair: the server side is handed to `onServerSocket`, the client side is returned open. */
async function connectPair(onServerSocket: (ws: WebSocket) => void): Promise<WebSocket> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  server.on('connection', onServerSocket);
  await once(server, 'listening');
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  sockets.push(client);
  await once(client, 'open');
  return client;
}

afterEach(() => {
  sockets.splice(0).forEach((ws) => ws.terminate());
  servers.splice(0).forEach((server) => server.close());
});

describe('createWebSocketTransport', () => {
  it('ws transport frames JSON messages and reports close', async () => {
    const received: string[] = [];
    const client = await connectPair((ws) => {
      ws.on('message', (data) => {
        received.push(data.toString());
        const { id } = JSON.parse(data.toString()) as { id: number };
        ws.send(JSON.stringify({ id, result: { ok: true } }));
        ws.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } }));
      });
    });
    const connection = new CdpConnection(createWebSocketTransport(client));
    const onEvent = vi.fn();
    connection.on('Page.loadEventFired', onEvent);

    await expect(connection.send('Page.enable', { a: 1 })).resolves.toEqual({ ok: true });
    expect(JSON.parse(received[0])).toMatchObject({ id: 1, method: 'Page.enable', params: { a: 1 } });
    expect(onEvent).toHaveBeenCalledWith({ timestamp: 1 }, undefined);

    const closed = vi.fn();
    connection.onClose(closed);
    client.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(connection.closed).toBe(true);
    await expect(connection.send('Page.enable')).rejects.toThrow(/closed/);
  });

  it('rejects pending commands when the server drops the socket', async () => {
    const client = await connectPair((ws) => ws.on('message', () => ws.terminate()));
    const connection = new CdpConnection(createWebSocketTransport(client));
    await expect(connection.send('Page.enable')).rejects.toThrow(/closed/);
  });

  it('reports close to a late subscriber when the socket was already closed', async () => {
    const client = await connectPair(() => {});
    client.terminate();
    await once(client, 'close');
    const closed = vi.fn();
    const transport = createWebSocketTransport(client);
    transport.onClose(closed);
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  });
});
