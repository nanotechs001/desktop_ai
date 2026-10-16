/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// No electron imports: this module also runs in plain Node (integration tests) and in the aion-browser MCP bundle.
import type { WebSocket } from 'ws';

const MESSAGE_DELIMITER = '\0';
const CLOSED_MESSAGE = 'CDP connection closed';

/** A bidirectional channel of whole CDP messages (JSON strings). */
export type CdpTransport = {
  send(message: string): void;
  onMessage(cb: (message: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
};

/** A CDP event: a message carrying `method` and `params` but no `id`. */
export type CdpEventMessage = { method: string; params: Record<string, unknown>; sessionId?: string };

/** A CDP command failed: the reply carried an `error` object. */
export class CdpError extends Error {
  readonly code: number;
  readonly method: string;

  constructor(message: string, code: number, method: string) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
    this.method = method;
  }
}

/**
 * Frame CDP over Chrome's `--remote-debugging-pipe`: write to `toChrome` (Chrome's fd 3) and read from
 * `fromChrome` (Chrome's fd 4). Every message in both directions is terminated by a NUL byte.
 * Closing the transport ends `toChrome`, which makes Chrome shut down.
 */
export function createPipeTransport(toChrome: NodeJS.WritableStream, fromChrome: NodeJS.ReadableStream): CdpTransport {
  const messageCallbacks: Array<(message: string) => void> = [];
  const closeCallbacks: Array<() => void> = [];
  let buffer = '';
  let closed = false;

  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    closeCallbacks.forEach((cb) => cb());
  };

  // Let the stream decode UTF-8 so a multi-byte character split across chunks stays intact.
  fromChrome.setEncoding('utf8');
  fromChrome.on('data', (chunk: string) => {
    if (closed) return;
    const parts = (buffer + chunk).split(MESSAGE_DELIMITER);
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part) messageCallbacks.forEach((cb) => cb(part));
    }
  });
  fromChrome.on('end', markClosed);
  fromChrome.on('close', markClosed);
  fromChrome.on('error', markClosed);
  toChrome.on('error', markClosed); // e.g. EPIPE once Chrome is gone

  return {
    send(message) {
      if (!closed) toChrome.write(message + MESSAGE_DELIMITER);
    },
    onMessage(cb) {
      messageCallbacks.push(cb);
    },
    onClose(cb) {
      closeCallbacks.push(cb);
    },
    close() {
      toChrome.end();
      markClosed();
    },
  };
}

/**
 * Frame CDP over an open WebSocket: one JSON message per text frame. `ws` is a type-only import, so
 * this module stays free of runtime dependencies. Closing the transport closes the socket.
 */
export function createWebSocketTransport(ws: WebSocket): CdpTransport {
  return {
    send(message) {
      if (ws.readyState === ws.OPEN) ws.send(message);
    },
    onMessage(cb) {
      ws.on('message', (data) => cb(data.toString()));
    },
    onClose(cb) {
      // A socket that is already closed will not emit 'close' again.
      if (ws.readyState === ws.CLOSED) queueMicrotask(cb);
      else ws.on('close', () => cb());
      ws.on('error', () => {}); // a socket error is followed by 'close'; unhandled it would crash the process
    },
    close() {
      ws.close();
    },
  };
}

/** Run a listener so that one throwing listener cannot stop the others or the message loop behind it. */
function safeInvoke(label: string, listener: () => void): void {
  try {
    listener();
  } catch (error) {
    console.error(`[CdpConnection] ${label} handler threw`, error);
  }
}

type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };
type EventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;
type IncomingMessage = {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
  method?: unknown;
  params?: unknown;
  sessionId?: unknown;
};

/** Request/response and event multiplexing for a CDP session over any {@link CdpTransport}. */
export class CdpConnection {
  private nextId = 1;
  private isClosed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private readonly anyHandlers = new Set<(event: CdpEventMessage) => void>();
  private readonly closeHandlers = new Set<() => void>();

  constructor(private readonly transport: CdpTransport) {
    transport.onMessage((message) => this.handleMessage(message));
    transport.onClose(() => this.handleClose());
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Send a command and resolve with its `result`; rejects with {@link CdpError} when Chrome replies with an error. */
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error(CLOSED_MESSAGE));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // Serialize first: if it throws (e.g. circular params) nothing is registered, so nothing leaks.
      const payload = JSON.stringify({ id, method, params, sessionId });
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
      this.transport.send(payload);
    });
  }

  /** Subscribe to one event method. Returns an unsubscribe function. */
  on(method: string, handler: EventHandler): () => void {
    const handlers = this.eventHandlers.get(method) ?? new Set<EventHandler>();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
    };
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  onAny(handler: (event: CdpEventMessage) => void): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  /** Subscribe to connection close. Returns an unsubscribe function. */
  onClose(cb: () => void): () => void {
    if (this.isClosed) {
      // Already closed: still tell the late subscriber, asynchronously (the returned unsubscribe is a no-op).
      queueMicrotask(() => safeInvoke('close', cb));
      return () => {};
    }
    this.closeHandlers.add(cb);
    return () => {
      this.closeHandlers.delete(cb);
    };
  }

  /** Close the connection and its transport; pending requests reject. Safe to call repeatedly. */
  close(): void {
    if (this.isClosed) return;
    try {
      this.handleClose();
    } finally {
      this.transport.close();
    }
  }

  private handleClose(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    pending.forEach(({ reject }) => reject(new Error(CLOSED_MESSAGE)));
    [...this.closeHandlers].forEach((cb) => safeInvoke('close', cb));
  }

  private handleMessage(raw: string): void {
    let message: IncomingMessage;
    try {
      message = JSON.parse(raw) as IncomingMessage;
    } catch {
      return; // a malformed chunk must not take the connection down
    }
    if (typeof message !== 'object' || message === null) return;

    if (typeof message.id === 'number') {
      this.handleReply(message.id, message);
    } else if (typeof message.method === 'string') {
      this.handleEvent(message.method, message);
    }
  }

  private handleReply(id: number, message: IncomingMessage): void {
    const request = this.pending.get(id);
    if (!request) return; // unknown id: already settled or never ours
    this.pending.delete(id);
    const { error } = message;
    if (error) {
      const text = typeof error.message === 'string' ? error.message : 'Unknown CDP error';
      const code = typeof error.code === 'number' ? error.code : 0;
      request.reject(new CdpError(text, code, request.method));
    } else {
      request.resolve(message.result);
    }
  }

  private handleEvent(method: string, message: IncomingMessage): void {
    const params =
      typeof message.params === 'object' && message.params !== null ? (message.params as Record<string, unknown>) : {};
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    [...(this.eventHandlers.get(method) ?? [])].forEach((handler) =>
      safeInvoke(method, () => handler(params, sessionId))
    );
    const event: CdpEventMessage = sessionId === undefined ? { method, params } : { method, params, sessionId };
    [...this.anyHandlers].forEach((handler) => safeInvoke(method, () => handler(event)));
  }
}
