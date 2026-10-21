// Core types for @aionui/web-host (M3 interface contract, locked for M4-M8)

/**
 * App metadata injected by host environment (Electron or Node)
 */
export type AppMetadata = {
  version: string;
  isPackaged: boolean;
  resourcesPath: string;
  userDataPath: string;
};

/**
 * Backend binary resolver function injected by host environment
 */
export type BackendBinaryResolver = () => string;

/**
 * System dirs exported to the backend via AIONUI_{CACHE,WORK,LOG}_DIR env.
 * Backend surfaces these on `/api/system/info`. Omit and the backend inherits
 * process.env, which may carry stale values from the parent shell — better to
 * be explicit.
 */
export type BackendSystemDirs = {
  cacheDir: string;
  workDir: string;
  logDir: string;
};

/** One tab the WebUI may watch (mirrors the desktop's browser-view ViewTab); `active` is the one the agent works in. */
export type BrowserViewTab = { id: string; title: string; url: string; active?: true };

/** How the desktop pushes one stream to the phone; `close` codes are forwarded as WebSocket close codes. */
export type BrowserViewPeer = {
  sendBinary(b: Buffer): void;
  sendText(s: string): void;
  close(code: number, reason: string): void;
};

export type BrowserViewStreamHandle = { onMessage(raw: string): void; close(): void };

/** The desktop's live browser-view service, used structurally so web-host never imports desktop code. */
export type BrowserViewRoutes = {
  listTabs(conversationId: string): BrowserViewTab[];
  openStream(
    tabId: string,
    peer: BrowserViewPeer
  ): Promise<BrowserViewStreamHandle | { error: 'tab-closed' | 'not-allowed' }>;
};

/** The desktop's loopback artifact server, used structurally; `port` is null while artifacts are unavailable. */
export type ArtifactViewRoutes = { port(): number | null };

/**
 * A risky agent action waiting for the user, as the phone sees it. `label` is the page's text: show it as text only.
 * `kind: 'leave'` is a page's "Leave site?" instead (allow means Leave); `kind: 'script'` asks to run a script that may
 * change the page (`label` is `</> ` and its code, `codeLength` the code's full length).
 */
export type BrowserConfirm = {
  id: string;
  origin: string;
  frameOrigin: string | null;
  label: string;
  kind?: 'leave' | 'script';
  codeLength?: number;
};

/** The desktop's pending agent confirmations, used structurally so web-host never imports desktop code. */
export type BrowserConfirmRoutes = {
  /** The chat's open asks. */
  listConfirms(conversationId: string): BrowserConfirm[];
  /** Answers one ask; false when the id is unknown or already answered (first answer wins). */
  answerConfirm(id: string, allow: boolean, always: boolean): boolean;
};

/** Routes the listener answers itself, after the auth gate, instead of forwarding them to aioncore. */
export type LocalRoutes = {
  browserView?: BrowserViewRoutes;
  browserConfirms?: BrowserConfirmRoutes;
  artifactView?: ArtifactViewRoutes;
};

/**
 * Options for starting WebHost
 */
export type WebHostOptions = {
  app: AppMetadata;
  staticDir: string;
  port?: number;
  allowRemote?: boolean;
  dataDir?: string;
  logDir?: string;
  dirs?: BackendSystemDirs;
  /** True while the Cloudflare tunnel runs (see StaticServerOptions.isTunnelActive). */
  isTunnelActive?: () => boolean;
  /** Epoch ms: sessions issued before it are refused (see StaticServerOptions.sessionsNotBefore). */
  sessionsNotBefore?: number | null;
  /** Routes answered here instead of by aioncore; without them those paths are forwarded as before. */
  localRoutes?: LocalRoutes;
  backend: { kind: 'ownBackend'; resolveBackend: BackendBinaryResolver } | { kind: 'useExistingBackend'; port: number };
};

/**
 * Handle returned by startWebHost
 */
export type WebHostHandle = {
  port: number;
  backendPort: number;
  url: string;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  /** Refuse sessions issued before this epoch ms (null = off); takes effect at once. */
  setSessionsNotBefore: (ms: number | null) => void;
  stop: () => Promise<void>;
};
