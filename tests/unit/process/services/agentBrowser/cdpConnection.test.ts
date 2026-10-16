/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CdpConnection,
  CdpError,
  createPipeTransport,
  type CdpEventMessage,
  type CdpTransport,
} from '@process/services/agentBrowser/cdpConnection';

function createFakeTransport() {
  const sent: string[] = [];
  let messageCb: ((message: string) => void) | undefined;
  let closeCb: (() => void) | undefined;
  const close = vi.fn(() => closeCb?.());
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
    close,
  };
  return {
    transport,
    sent,
    close,
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

  it('resolves concurrent send() calls with their own result when replies arrive out of order', async () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);

    const first = connection.send('A.one');
    const second = connection.send('A.two');
    const third = connection.send('A.three');
    fake.push('{"id":3,"result":{"n":3}}');
    fake.push('{"id":1,"result":{"n":1}}');
    fake.push('{"id":2,"error":{"code":-1,"message":"two failed"}}');

    await expect(first).resolves.toEqual({ n: 1 });
    await expect(second).rejects.toMatchObject({ code: -1, message: 'two failed', method: 'A.two' });
    await expect(third).resolves.toEqual({ n: 3 });
  });

  it('close() closes the transport once, even when called repeatedly', () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);

    connection.close();
    connection.close();

    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('close() still closes the transport and notifies the other handlers when a close handler throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);
    const healthy = vi.fn();
    connection.onClose(() => {
      throw new Error('close handler bug');
    });
    connection.onClose(healthy);

    expect(() => connection.close()).not.toThrow();

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('invokes a late onClose() subscriber once, asynchronously', async () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);
    connection.close();
    const late = vi.fn();

    connection.onClose(late);
    expect(late).not.toHaveBeenCalled();
    await Promise.resolve();

    expect(late).toHaveBeenCalledTimes(1);
  });

  it('rejects send() with unserializable params without leaking a pending request', async () => {
    const fake = createFakeTransport();
    const connection = new CdpConnection(fake.transport);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(connection.send('A.b', circular)).rejects.toThrow(TypeError);

    expect(fake.sent).toEqual([]);
    // Inspect the private map: a settled promise would hide a leaked entry otherwise.
    expect((connection as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0);
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

describe('CdpConnection handler isolation', () => {
  it('keeps delivering to other handlers and later messages in the same chunk when a handler throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fromChrome = new PassThrough();
    const connection = new CdpConnection(createPipeTransport(new PassThrough(), fromChrome));
    const healthyOn = vi.fn();
    const healthyAny = vi.fn();
    connection.on('A.b', () => {
      throw new Error('on handler bug');
    });
    connection.on('A.b', healthyOn);
    connection.onAny(() => {
      throw new Error('onAny handler bug');
    });
    connection.onAny(healthyAny);

    const reply = connection.send<{ ok: boolean }>('A.c');
    fromChrome.write('{"method":"A.b","params":{"x":1}}\0{"id":1,"result":{"ok":true}}\0');

    await expect(reply).resolves.toEqual({ ok: true });
    expect(healthyOn).toHaveBeenCalledWith({ x: 1 }, undefined);
    expect(healthyAny).toHaveBeenCalledWith({ method: 'A.b', params: { x: 1 } });
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError.mock.calls[0][0]).toContain('A.b');
    consoleError.mockRestore();
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

  it('close() ends the stream to Chrome, which is how Chrome is told to exit', async () => {
    const toChrome = new PassThrough();
    const transport = createPipeTransport(toChrome, new PassThrough());
    const finished = once(toChrome, 'finish');

    transport.close();

    await finished;
    expect(toChrome.writableEnded).toBe(true);
  });

  it('notifies onClose when Chrome closes the pipe, and once only', async () => {
    const fromChrome = new PassThrough();
    const transport = createPipeTransport(new PassThrough(), fromChrome);
    const onClose = vi.fn();
    transport.onClose(onClose);
    const streamClosed = once(fromChrome, 'close');

    fromChrome.end();
    await streamClosed; // both 'end' and 'close' have fired by now; each must not notify again

    expect(onClose).toHaveBeenCalledTimes(1);
    transport.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
