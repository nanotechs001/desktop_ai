/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CdpConnection,
  CdpError,
  createPipeTransport,
  type CdpEventMessage,
  type CdpTransport,
} from '@process/services/chromeHost/launch/cdpConnection';

function createFakeTransport() {
  const sent: string[] = [];
  let messageCb: ((message: string) => void) | undefined;
  let closeCb: (() => void) | undefined;
  const transport: CdpTransport = {
    send: (message) => {
      sent.push(message);
    },
    onMessage: (cb) => {
      messageCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    close: () => closeCb?.(),
  };
  return {
    transport,
    sent,
    push: (message: string) => messageCb?.(message),
    closeTransport: () => closeCb?.(),
  };
}

describe('CdpConnection', () => {
  it('resolves send() with the result matching the request id', async () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);

    const pending = connection.send<{ v: number }>('Runtime.evaluate');
    fake.push('{"id":1,"result":{"v":2}}');

    await expect(pending).resolves.toEqual({ v: 2 });
  });

  it('sends method, params and sessionId in one JSON message', () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);

    void connection.send('Page.navigate', { url: 'u' }, 'S');

    expect(fake.sent).toHaveLength(1);
    expect(JSON.parse(fake.sent[0])).toEqual({ id: 1, method: 'Page.navigate', params: { url: 'u' }, sessionId: 'S' });
  });

  it('rejects with CdpError carrying code, message and method', async () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);

    const pending = connection.send('X.y');
    fake.push('{"id":1,"error":{"code":-32000,"message":"boom"}}');

    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CdpError);
    expect(error).toMatchObject({ code: -32000, message: 'boom', method: 'X.y' });
  });

  it('passes event params and sessionId to on() and onAny() handlers', () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);
    const onHandler = vi.fn();
    const anyHandler = vi.fn();
    connection.on('Page.loadEventFired', onHandler);
    connection.onAny(anyHandler);

    fake.push('{"method":"Page.loadEventFired","params":{},"sessionId":"S"}');

    expect(onHandler).toHaveBeenCalledWith({}, 'S');
    const expected: CdpEventMessage = { method: 'Page.loadEventFired', params: {}, sessionId: 'S' };
    expect(anyHandler).toHaveBeenCalledWith(expected);
  });

  it('stops calling a handler once its unsubscribe function ran', () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);
    const handler = vi.fn();
    const unsubscribe = connection.on('A.b', handler);

    unsubscribe();
    fake.push('{"method":"A.b","params":{}}');

    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects every pending request with "CDP connection closed" when the transport closes', async () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);
    const onClose = vi.fn();
    connection.onClose(onClose);

    const first = connection.send('A.one');
    const second = connection.send('A.two');
    fake.closeTransport();

    await expect(first).rejects.toThrow('CDP connection closed');
    await expect(second).rejects.toThrow('CDP connection closed');
    expect(connection.closed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects send() immediately after close() and after the transport closed', async () => {
    const closedByCaller = createFakeTransport();
    const first = new CdpConnection(closedByCaller.transport);
    first.close();
    await expect(first.send('A.b')).rejects.toThrow('CDP connection closed');
    expect(closedByCaller.sent).toEqual([]);

    const closedByTransport = createFakeTransport();
    const second = new CdpConnection(closedByTransport.transport);
    closedByTransport.closeTransport();
    await expect(second.send('A.b')).rejects.toThrow('CDP connection closed');
    expect(closedByTransport.sent).toEqual([]);
  });

  it('ignores replies with an unknown id', async () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);

    const pending = connection.send('A.b');
    fake.push('{"id":99,"result":{}}');
    fake.push('{"id":1,"result":{"ok":true}}');

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('drops malformed JSON without breaking the connection', async () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);

    const pending = connection.send('A.b');
    expect(() => fake.push('{not json')).not.toThrow();
    fake.push('{"id":1,"result":{"ok":true}}');

    await expect(pending).resolves.toEqual({ ok: true });
    expect(connection.closed).toBe(false);
  });
});

describe('createPipeTransport', () => {
  it('splits NUL-delimited messages across chunk boundaries', async () => {
    const fromChrome = new PassThrough();
    const transport = createPipeTransport(new PassThrough(), fromChrome);
    const received: string[] = [];
    transport.onMessage((message) => received.push(message));

    fromChrome.write('{"id":1}\0{"i');
    fromChrome.write('d":2}\0');

    await vi.waitFor(() => expect(received).toEqual(['{"id":1}', '{"id":2}']));
  });

  it('keeps multi-byte characters intact when a chunk splits them', async () => {
    const fromChrome = new PassThrough();
    const transport = createPipeTransport(new PassThrough(), fromChrome);
    const received: string[] = [];
    transport.onMessage((message) => received.push(message));

    const bytes = Buffer.from('{"t":"€"}\0');
    const splitAt = bytes.indexOf(0xe2) + 1;
    fromChrome.write(bytes.subarray(0, splitAt));
    fromChrome.write(bytes.subarray(splitAt));

    await vi.waitFor(() => expect(received).toEqual(['{"t":"€"}']));
  });

  it('terminates each written message with a NUL byte', async () => {
    const toChrome = new PassThrough();
    const transport = createPipeTransport(toChrome, new PassThrough());
    const written: string[] = [];
    toChrome.on('data', (chunk: Buffer) => written.push(chunk.toString()));

    transport.send('{"id":1}');
    transport.send('{"id":2}');

    await vi.waitFor(() => expect(written.join('')).toBe('{"id":1}\0{"id":2}\0'));
  });

  it('notifies onClose when Chrome closes the pipe, and once only', async () => {
    const fromChrome = new PassThrough();
    const transport = createPipeTransport(new PassThrough(), fromChrome);
    const onClose = vi.fn();
    transport.onClose(onClose);

    fromChrome.end();

    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    transport.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
