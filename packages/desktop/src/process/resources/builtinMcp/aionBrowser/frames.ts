/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CdpConnection } from '@process/services/agentBrowser/cdpConnection';

/** One observable frame of a tab: where its snapshot runs and where its content sits in the top viewport. */
export type FrameHandle = {
  /** `f<k>`: names exactly one isolated world, so `f<k>:<n>` names exactly one element. */
  frameKey: string;
  /** Owner iframe's title, name or id, else the frame's origin (page-derived, unsanitized). */
  label: string;
  /** The flattened CDP session the frame lives in (the page session, or an OOPIF child session). */
  sessionId: string;
  /** Our isolated world in the frame's current document. */
  contextId: number;
  /** The frame's content-box origin in top-viewport CSS px. */
  offset: { x: number; y: number };
};

/** A frame that did not answer in time or failed: by key once it has one, else by its (unsanitized) origin. */
export type FrameFailure = { frameKey?: string; label: string };

/** How long one frame may take per stage (frame tree, placement and world, snapshot) before it is reported. */
export const FRAME_TIMEOUT_MS = 2000;

const WORLD_NAME = 'aion-browser';
/** Label for an OOPIF that never answered and has neither a key nor a url yet. */
const UNKNOWN_FRAME = 'a cross-origin frame';

type CdpFrame = { id: string; loaderId: string; url: string; securityOrigin?: string };
type CdpFrameTree = { frame: CdpFrame; childFrames?: CdpFrameTree[] };
type Point = { x: number; y: number };
type Box = Point & { w: number; h: number };

/** A frame found in one session's frame tree; `ownerSession` holds its iframe element (null for the top frame). */
type FoundFrame = { frame: CdpFrame; sessionId: string; ownerSession: string | null };
type Placement = { offset: Point; name?: string } | null;
/** A frame key and the one world it names; minted together, retired together. */
type FrameWorld = { frameKey: string; world: Promise<number> };

type TabFrames = {
  /** By `sessionId|frameId|loaderId` (one document). Kept while the frame is off-screen. */
  worlds: Map<string, FrameWorld>;
  handles: Map<string, FrameHandle>;
};
type ConnFrames = {
  /** OOPIF child session -> its parent session, target (frame) id and url at attach time. */
  children: Map<string, { parent: string; targetId: string; url: string }>;
  /** Per page session. */
  tabs: Map<string, TabFrames>;
  nextKey: number;
};

const states = new WeakMap<CdpConnection, ConnFrames>();

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** `promise`, or a rejection after `ms`; the late result is ignored. */
export const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const dropSession = (state: ConnFrames, sessionId: string): void => {
  for (const [child, { parent }] of state.children) if (parent === sessionId) dropSession(state, child);
  state.children.delete(sessionId);
  state.tabs.delete(sessionId);
};

/**
 * Starts tracking OOPIF child sessions on `conn`. Call it as soon as the connection exists: the relay announces
 * a tab's existing OOPIFs right after the attach reply, and later ones whenever they attach.
 */
export function watchFrames(conn: CdpConnection): void {
  if (states.has(conn)) return;
  const state: ConnFrames = { children: new Map(), tabs: new Map(), nextKey: 0 };
  states.set(conn, state);
  conn.on('Target.attachedToTarget', (params, parent) => {
    const info = asRecord(params.targetInfo);
    if (!parent || typeof params.sessionId !== 'string' || info.type !== 'iframe') return;
    if (typeof info.targetId !== 'string') return;
    const url = typeof info.url === 'string' ? info.url : '';
    state.children.set(params.sessionId, { parent, targetId: info.targetId, url });
  });
  conn.on('Target.detachedFromTarget', (params) => {
    if (typeof params.sessionId === 'string') dropSession(state, params.sessionId);
  });
}

const stateOf = (conn: CdpConnection): ConnFrames => {
  watchFrames(conn);
  return states.get(conn) as ConnFrames;
};

/** The frame from the latest {@link collectFrames} of the tab, for acting on an observed `f<k>:<n>` id. */
export const frameByKey = (conn: CdpConnection, pageSessionId: string, frameKey: string): FrameHandle | undefined =>
  states.get(conn)?.tabs.get(pageSessionId)?.handles.get(frameKey);

/**
 * Retires a frame key with its isolated world (e.g. its snapshot failed): the next collect makes a fresh world under
 * a new key, so ids observed under the old key can never point at another element.
 */
export const forgetWorld = (conn: CdpConnection, pageSessionId: string, frameKey: string): void => {
  const tab = states.get(conn)?.tabs.get(pageSessionId);
  for (const [doc, entry] of tab?.worlds ?? []) if (entry.frameKey === frameKey) tab?.worlds.delete(doc);
  tab?.handles.delete(frameKey);
};

const descendants = (state: ConnFrames, sessionId: string): string[] =>
  [...state.children]
    .filter(([, c]) => c.parent === sessionId)
    .flatMap(([child]) => [child, ...descendants(state, child)]);

const originOfUrl = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

const originOf = (frame: CdpFrame): string =>
  frame.securityOrigin && frame.securityOrigin !== '://' ? frame.securityOrigin : originOfUrl(frame.url);

/** Frames of one session's tree, minus OOPIFs (their own sessions report them). */
const framesOf = (
  tree: CdpFrameTree,
  sessionId: string,
  ownerOfRoot: string | null,
  oopifs: Set<string>
): FoundFrame[] => {
  const found: FoundFrame[] = [];
  const walk = (node: CdpFrameTree, isRoot: boolean): void => {
    if (!isRoot && oopifs.has(node.frame.id)) return;
    found.push({ frame: node.frame, sessionId, ownerSession: isRoot ? ownerOfRoot : sessionId });
    node.childFrames?.forEach((child) => walk(child, false));
  };
  walk(tree, true);
  return found;
};

const ownerBox = async (conn: CdpConnection, frameId: string, sessionId: string) => {
  const { backendNodeId } = await conn.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId }, sessionId);
  const [{ model }, { node }] = await Promise.all([
    conn.send<{ model: { content: number[] } }>('DOM.getBoxModel', { backendNodeId }, sessionId),
    conn.send<{ node: { attributes?: string[] } }>('DOM.describeNode', { backendNodeId }, sessionId),
  ]);
  const [x1, y1, x2, , , y3] = model.content;
  // CDP lists attributes as a flat [name, value, name, value, ...] array.
  const attrs = node.attributes ?? [];
  const attr = (key: string): string => {
    const at = attrs.findIndex((name, i) => i % 2 === 0 && name === key);
    return at < 0 ? '' : (attrs[at + 1] ?? '');
  };
  const named = ['title', 'name', 'id'].map((key) => attr(key).trim()).find(Boolean);
  return { box: { x: x1, y: y1, w: x2 - x1, h: y3 - y1 }, name: named };
};

const intersects = (box: Box, viewport: { w: number; h: number }): boolean =>
  box.w > 0 && box.h > 0 && box.x < viewport.w && box.y < viewport.h && box.x + box.w > 0 && box.y + box.h > 0;

type FoundFrames = { found: FoundFrame[]; sessionRoot: Map<string, string>; failed: FrameFailure[] };

/** Frame trees of the page session and every OOPIF session under it; a session that does not answer is reported. */
const findFrames = async (
  conn: CdpConnection,
  state: ConnFrames,
  pageSessionId: string,
  topTree: CdpFrameTree,
  previous: TabFrames | undefined
): Promise<FoundFrames> => {
  const childSessions = descendants(state, pageSessionId);
  const oopifs = new Set(childSessions.map((s) => state.children.get(s)?.targetId ?? ''));
  const childTrees = await Promise.allSettled(
    childSessions.map((s) =>
      withTimeout(conn.send<{ frameTree: CdpFrameTree }>('Page.getFrameTree', {}, s), FRAME_TIMEOUT_MS, 'A frame')
    )
  );
  const found = framesOf(topTree, pageSessionId, null, oopifs);
  const sessionRoot = new Map<string, string>([[pageSessionId, topTree.frame.id]]);
  const failed: FrameFailure[] = [];
  childSessions.forEach((s, i) => {
    const tree = childTrees[i];
    const child = state.children.get(s);
    if (tree.status === 'rejected') {
      // An OOPIF attaches before its url is known, so prefer the key it was observed under.
      const root = `${s}|${child?.targetId ?? ''}|`;
      const known = [...(previous?.worlds ?? [])].find(([doc]) => doc.startsWith(root))?.[1].frameKey;
      failed.push({ frameKey: known, label: child?.url ? originOfUrl(child.url) : UNKNOWN_FRAME });
      return;
    }
    sessionRoot.set(s, tree.value.frameTree.frame.id);
    found.push(...framesOf(tree.value.frameTree, s, child?.parent ?? null, oopifs));
  });
  return { found, sessionRoot, failed };
};

/**
 * Every visible frame of the tab behind `pageSessionId`, plus the frames that did not answer in time. See
 * {@link collectFrames}.
 */
export async function collectFramesReport(
  conn: CdpConnection,
  pageSessionId: string
): Promise<{ frames: FrameHandle[]; failed: FrameFailure[] }> {
  const state = stateOf(conn);
  // The relay sends a tab's known OOPIFs before any reply that follows the attach, so read children after this.
  const [metrics, topTree] = await withTimeout(
    Promise.all([
      conn.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
        'Page.getLayoutMetrics',
        {},
        pageSessionId
      ),
      conn.send<{ frameTree: CdpFrameTree }>('Page.getFrameTree', {}, pageSessionId),
    ]),
    FRAME_TIMEOUT_MS,
    'The page'
  );
  const viewport = { w: metrics.cssLayoutViewport.clientWidth, h: metrics.cssLayoutViewport.clientHeight };
  const previous = state.tabs.get(pageSessionId);
  const { found, sessionRoot, failed } = await findFrames(conn, state, pageSessionId, topTree.frameTree, previous);
  const byId = new Map(found.map((f) => [f.frame.id, f]));

  // Content origin in top-viewport px, or null when the frame (or one around it) is not on screen.
  const placed = new Map<string, Promise<Placement>>();
  const place = (f: FoundFrame): Promise<Placement> => {
    const memo = placed.get(f.frame.id);
    if (memo) return memo;
    const result = (async (): Promise<Placement> => {
      if (!f.ownerSession) return { offset: { x: 0, y: 0 } };
      // The owner's box is relative to the viewport of its session's root frame.
      const ownerRoot = byId.get(sessionRoot.get(f.ownerSession) ?? '');
      if (!ownerRoot) return null;
      const [base, owner] = await Promise.all([place(ownerRoot), ownerBox(conn, f.frame.id, f.ownerSession)]);
      if (!base) return null;
      const box = { ...owner.box, x: owner.box.x + base.offset.x, y: owner.box.y + base.offset.y };
      return intersects(box, viewport) ? { offset: { x: box.x, y: box.y }, name: owner.name } : null;
    })().catch((): Placement => null); // a frame that detached mid-call is simply not observed
    placed.set(f.frame.id, result);
    return result;
  };

  const tab: TabFrames = { worlds: new Map(), handles: new Map() };
  const settle = async (f: FoundFrame): Promise<FrameHandle | null> => {
    const doc = `${f.sessionId}|${f.frame.id}|${f.frame.loaderId}`;
    const kept = previous?.worlds.get(doc);
    if (kept) tab.worlds.set(doc, kept); // an off-screen frame keeps its key and world for when it returns
    const where = await place(f);
    if (!where) return null;
    const entry: FrameWorld = kept ?? {
      frameKey: `f${state.nextKey++}`,
      world: conn
        .send<{ executionContextId: number }>(
          'Page.createIsolatedWorld',
          { frameId: f.frame.id, worldName: WORLD_NAME },
          f.sessionId
        )
        .then(({ executionContextId }) => executionContextId),
    };
    tab.worlds.set(doc, entry);
    try {
      const contextId = await entry.world;
      const label = where.name || originOf(f.frame);
      return { frameKey: entry.frameKey, label, sessionId: f.sessionId, contextId, offset: where.offset };
    } catch (error) {
      tab.worlds.delete(doc); // the frame went away mid-call; a later collect starts over with a new key
      throw error;
    }
  };
  const results = await Promise.allSettled(found.map((f) => withTimeout(settle(f), FRAME_TIMEOUT_MS, 'A frame')));
  const frames: FrameHandle[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      if (result.value) frames.push(result.value);
      return;
    }
    const doc = `${found[i].sessionId}|${found[i].frame.id}|${found[i].frame.loaderId}`;
    failed.push({ frameKey: tab.worlds.get(doc)?.frameKey, label: originOf(found[i].frame) });
  });
  frames.forEach((h) => tab.handles.set(h.frameKey, h));
  state.tabs.set(pageSessionId, tab);
  return { frames, failed };
}

/**
 * Every visible frame of the tab behind `pageSessionId`: the top frame, same-origin iframes (same session) and
 * OOPIFs (child sessions), each with an isolated world and its offset in the top viewport. Frames whose owner
 * box is zero-size or entirely off-screen are skipped, with everything inside them. Top frame first.
 */
export async function collectFrames(conn: CdpConnection, pageSessionId: string): Promise<FrameHandle[]> {
  return (await collectFramesReport(conn, pageSessionId)).frames;
}
