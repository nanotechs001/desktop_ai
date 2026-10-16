import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export const FAKE_TOKEN = 'secret-token';

type Params = Record<string, unknown>;
export type FakeRelayHandler = (params: Params, sessionId: string | undefined) => unknown;

/** A stand-in for the agent relay: Bearer-guarded ws server answering CDP-style requests. */
export class FakeRelay {
  readonly requests: Array<{ method: string; params: Params; sessionId?: string }> = [];
  /** `?client=` label of each accepted connection, in order. */
  readonly labels: string[] = [];
  /** Authorization headers of refused upgrades. */
  readonly refused: Array<string | undefined> = [];
  readonly sockets = new Set<WebSocket>();
  /** Per-method reply; a thrown Error becomes a CDP error reply. */
  readonly handlers = new Map<string, FakeRelayHandler>();
  private server!: WebSocketServer;

  static async start(): Promise<FakeRelay> {
    const relay = new FakeRelay();
    relay.server = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: ({ req }) => {
        const ok = req.headers.authorization === `Bearer ${FAKE_TOKEN}` && !req.url?.includes('token=');
        if (!ok) relay.refused.push(req.headers.authorization);
        return ok;
      },
    });
    relay.server.on('connection', (ws, req) => relay.onConnection(ws, req.url ?? '/'));
    await once(relay.server, 'listening');
    return relay;
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/`;
  }

  get env(): NodeJS.ProcessEnv {
    return { AION_BROWSER_RELAY_URL: this.url, AION_BROWSER_RELAY_TOKEN: FAKE_TOKEN };
  }

  on(method: string, handler: FakeRelayHandler): void {
    this.handlers.set(method, handler);
  }

  callsTo(method: string): Params[] {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }

  /** Pushes a CDP event to every client, tagged with `sessionId` when given. */
  emit(method: string, params: Params, sessionId?: string): void {
    this.sockets.forEach((ws) => ws.send(JSON.stringify({ method, params, sessionId })));
  }

  /** Closes every client socket the way a restarting relay does. */
  dropClients(code = 1012): void {
    this.sockets.forEach((ws) => ws.close(code));
  }

  async stop(): Promise<void> {
    this.sockets.forEach((ws) => ws.terminate());
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private onConnection(ws: WebSocket, url: string): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    this.labels.push(new URL(url, 'http://x').searchParams.get('client') ?? '');
    ws.on('message', async (data) => {
      const {
        id,
        method,
        params = {},
        sessionId,
      } = JSON.parse(data.toString()) as {
        id: number;
        method: string;
        params?: Params;
        sessionId?: string;
      };
      this.requests.push({ method, params, sessionId });
      try {
        const handler = this.handlers.get(method);
        if (!handler) throw new Error(`${method} is not allowed for agents`);
        ws.send(JSON.stringify({ id, result: (await handler(params, sessionId)) ?? {}, sessionId }));
      } catch (error) {
        ws.send(JSON.stringify({ id, error: { code: -32000, message: (error as Error).message }, sessionId }));
      }
    });
  }
}
