import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

type CommandHandler = (method: string, params: unknown, sessionId: string | undefined) => unknown;

/** Stands in for `webContents.debugger`: records commands, lets a test emit protocol events. */
export class FakeDebugger extends EventEmitter {
  attached = false;
  attachError: string | null = null;
  handler: CommandHandler = () => ({});
  readonly sendCommand = vi.fn(async (method: string, params?: unknown, sessionId?: string) =>
    this.handler(method, params, sessionId)
  );

  attach(_version?: string): void {
    if (this.attachError) throw new Error(this.attachError);
    if (this.attached) throw new Error('Debugger is already attached to the target');
    this.attached = true;
  }

  detach(): void {
    this.attached = false;
  }

  isAttached(): boolean {
    return this.attached;
  }

  /** Emits a protocol event the way Electron does; `sessionId` is '' for the top session. */
  message(method: string, params: Record<string, unknown>, sessionId = ''): void {
    this.emit('message', {}, method, params, sessionId);
  }
}

/** Stands in for a browser tab's WebContents. */
export class FakeContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  readonly reload = vi.fn();
  readonly reloadIgnoringCache = vi.fn();
  private destroyed = false;

  zoom = 1;

  constructor(
    readonly id: number,
    private readonly url = 'https://example.com/',
    private readonly title = 'Example',
    private readonly type = 'webview'
  ) {
    super();
  }

  getType(): string {
    return this.type;
  }

  getZoomFactor(): number {
    return this.zoom;
  }

  /** Emits the tab's first main-frame navigation the way Electron does. */
  navigate(url: string, isMainFrame = true): void {
    this.emit('did-start-navigation', { url, isMainFrame });
  }

  getURL(): string {
    return this.url;
  }

  getTitle(): string {
    return this.title;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.debugger.attached = false;
    this.emit('destroyed');
  }
}
