import type { ConfigKey, ConfigKeyMap } from './configKeys';

type Subscriber = (value: unknown) => void;
/** Keys this window stored, with their new values (`null`: removed). */
type WriteListener = (entries: Record<string, unknown>) => void;

declare global {
  interface Window {
    __backendPort?: number;
  }
}

function getBaseUrl(): string {
  // WebUI browser mode: no preload, fetch same-origin so web-host's
  // static-server reverse-proxies /api/* to the backend.
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && !(window as Window).__backendPort) {
    return '';
  }
  const port = typeof window !== 'undefined' ? (window as Window).__backendPort || 13400 : 13400;
  return `http://127.0.0.1:${port}`;
}

async function fetchJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`ConfigService ${method} ${path} failed (${response.status}): ${errorBody}`);
  }
  const contentType = response.headers.get('Content-Type');
  if (!contentType?.includes('application/json')) {
    return undefined as T;
  }
  const json = await response.json();
  if (json && typeof json === 'object' && 'data' in json) {
    return json.data as T;
  }
  return json as T;
}

class ConfigServiceImpl {
  private cache = new Map<string, unknown>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private writeListeners = new Set<WriteListener>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // Idempotent: concurrent callers share the same in-flight promise, and a
  // resolved init returns immediately. Modules that need persisted settings on
  // module load (theme/language) await whenReady() before reading.
  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const data = await fetchJson<Record<string, unknown>>('GET', '/api/settings/client');
      this.cache.clear();
      if (data) {
        for (const [key, value] of Object.entries(data)) {
          this.cache.set(key, value);
        }
      }
      this.initialized = true;
    })();
    this.initPromise.catch(() => {
      // Allow a future caller to retry after a transient failure
      this.initPromise = null;
    });
    return this.initPromise;
  }

  whenReady(): Promise<void> {
    return this.initialize();
  }

  get<K extends ConfigKey>(key: K): ConfigKeyMap[K] | undefined {
    return this.cache.get(key) as ConfigKeyMap[K] | undefined;
  }

  async set<K extends ConfigKey>(key: K, value: ConfigKeyMap[K]): Promise<void> {
    this.cache.set(key, value);
    this.notify(key, value);
    await fetchJson<void>('PUT', '/api/settings/client', { [key]: value });
    this.announce({ [key]: value });
  }

  setLocal<K extends ConfigKey>(key: K, value: ConfigKeyMap[K]): void {
    this.cache.set(key, value);
    this.notify(key, value);
  }

  async remove(key: ConfigKey): Promise<void> {
    this.cache.delete(key);
    this.notify(key, undefined);
    await fetchJson<void>('PUT', '/api/settings/client', { [key]: null });
    this.announce({ [key]: null });
  }

  async setBatch(entries: Partial<{ [K in ConfigKey]: ConfigKeyMap[K] }>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      this.cache.set(key, value);
      this.notify(key as ConfigKey, value);
    }
    await fetchJson<void>('PUT', '/api/settings/client', entries);
    this.announce(entries);
  }

  /**
   * Called after each stored write (not `setLocal`), so the other windows, which keep their own cache, can follow.
   * Returns the unsubscribe.
   */
  onWrite(listener: WriteListener): () => void {
    this.writeListeners.add(listener);
    return () => {
      this.writeListeners.delete(listener);
    };
  }

  /** Values another window stored: this cache and its subscribers follow; nothing is written (`null`: removed). */
  applyRemote(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) {
      if (value === null) this.cache.delete(key);
      else this.cache.set(key, value);
      this.notify(key as ConfigKey, value ?? undefined);
    }
  }

  /** Re-read `keys` from the stored settings, before a read-modify-write another window may have raced. */
  async reload(keys: readonly ConfigKey[]): Promise<void> {
    const data = (await fetchJson<Record<string, unknown> | undefined>('GET', '/api/settings/client')) ?? {};
    this.applyRemote(Object.fromEntries(keys.map((key) => [key, data[key] ?? null])));
  }

  subscribe(key: ConfigKey, callback: Subscriber): () => void {
    if (!this.subscribers.has(key)) {
      this.subscribers.set(key, new Set());
    }
    this.subscribers.get(key)!.add(callback);
    return () => {
      this.subscribers.get(key)?.delete(callback);
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  reset(): void {
    this.cache.clear();
    this.subscribers.clear();
    this.initialized = false;
    this.initPromise = null;
  }

  private announce(entries: Record<string, unknown>): void {
    for (const listener of this.writeListeners) listener(entries);
  }

  private notify(key: ConfigKey, value: unknown): void {
    const subs = this.subscribers.get(key);
    if (subs) {
      for (const cb of subs) {
        cb(value);
      }
    }
  }
}

export const configService = new ConfigServiceImpl();
