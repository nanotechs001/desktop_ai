/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CdpConnection } from '@process/services/agentBrowser/cdpConnection';

/** One observable frame of a tab: where its snapshot runs and where its content sits in the top viewport. */
export type FrameHandle = {
  /** `f<k>`: stable while the frame keeps its document. */
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

const WORLD_NAME = 'aion-browser';

type CdpFrame = { id: string; loaderId: string; url: string; securityOrigin?: string };
type CdpFrameTree = { frame: CdpFrame; childFrames?: CdpFrameTree[] };
type Point = { x: number; y: number };
type Box = Point & { w: number; h: number };

/** A frame found in one session's frame tree; `ownerSession` holds its iframe element (null for the top frame). */
type FoundFrame = { frame: CdpFrame; sessionId: string; ownerSession: string | null };
type Placement = { offset: Point; name?: string } | null;

type TabFrames = { keys: Map<string, string>; worlds: Map<string, Promise<number>>; handles: Map<string, FrameHandle> };
type ConnFrames = {
  /** OOPIF child session -> its parent session and target (frame) id. */
  children: Map<string, { parent: string; targetId: string }>;
  /** Per page session. */
  tabs: Map<string, TabFrames>;
  nextKey: number;
};

const states = new WeakMap<CdpConnection, ConnFrames>();

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

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
    if (typeof info.targetId === 'string') state.children.set(params.sessionId, { parent, targetId: info.targetId });
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

/** Forgets a frame's isolated world (e.g. its evaluation failed), so the next collect creates a fresh one. */
export const forgetWorld = (conn: CdpConnection, pageSessionId: string, frameKey: string): void => {
  const tab = states.get(conn)?.tabs.get(pageSessionId);
  for (const [doc, key] of tab?.keys ?? []) if (key === frameKey) tab?.worlds.delete(doc);
};

const descendants = (state: ConnFrames, sessionId: string): string[] =>
  [...state.children]
    .filter(([, c]) => c.parent === sessionId)
    .flatMap(([child]) => [child, ...descendants(state, child)]);

const originOf = (frame: CdpFrame): string => {
  if (frame.securityOrigin && frame.securityOrigin !== '://') return frame.securityOrigin;
  try {
    return new URL(frame.url).origin;
  } catch {
    return frame.url;
  }
};

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

/**
 * Every visible frame of the tab behind `pageSessionId`: the top frame, same-origin iframes (same session) and
 * OOPIFs (child sessions), each with an isolated world and its offset in the top viewport. Frames whose owner
 * box is zero-size or entirely off-screen are skipped, with everything inside them. Top frame first.
 */
export async function collectFrames(conn: CdpConnection, pageSessionId: string): Promise<FrameHandle[]> {
  const state = stateOf(conn);
  // The relay sends a tab's known OOPIFs before any reply that follows the attach, so read children after this.
  const [metrics, topTree] = await Promise.all([
    conn.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
      'Page.getLayoutMetrics',
      {},
      pageSessionId
    ),
    conn.send<{ frameTree: CdpFrameTree }>('Page.getFrameTree', {}, pageSessionId),
  ]);
  const viewport = { w: metrics.cssLayoutViewport.clientWidth, h: metrics.cssLayoutViewport.clientHeight };
  const childSessions = descendants(state, pageSessionId);
  const oopifs = new Set(childSessions.map((s) => state.children.get(s)?.targetId ?? ''));
  const childTrees = await Promise.allSettled(
    childSessions.map((s) => conn.send<{ frameTree: CdpFrameTree }>('Page.getFrameTree', {}, s))
  );
  const found = [
    ...framesOf(topTree.frameTree, pageSessionId, null, oopifs),
    ...childSessions.flatMap((s, i) => {
      const tree = childTrees[i];
      return tree.status === 'fulfilled'
        ? framesOf(tree.value.frameTree, s, state.children.get(s)?.parent ?? null, oopifs)
        : [];
    }),
  ];
  const byId = new Map(found.map((f) => [f.frame.id, f]));
  const sessionRoot = new Map<string, string>([[pageSessionId, topTree.frameTree.frame.id]]);
  childSessions.forEach((s, i) => {
    const tree = childTrees[i];
    if (tree.status === 'fulfilled') sessionRoot.set(s, tree.value.frameTree.frame.id);
  });

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

  const previous = state.tabs.get(pageSessionId);
  const tab: TabFrames = { keys: new Map(), worlds: new Map(), handles: new Map() };
  const handles = await Promise.all(
    found.map(async (f): Promise<FrameHandle | null> => {
      const doc = `${f.sessionId}|${f.frame.id}|${f.frame.loaderId}`;
      const frameKey = previous?.keys.get(doc) ?? `f${state.nextKey++}`;
      tab.keys.set(doc, frameKey);
      const where = await place(f);
      if (!where) return null;
      const world =
        previous?.worlds.get(doc) ??
        conn
          .send<{ executionContextId: number }>(
            'Page.createIsolatedWorld',
            { frameId: f.frame.id, worldName: WORLD_NAME },
            f.sessionId
          )
          .then(({ executionContextId }) => executionContextId);
      tab.worlds.set(doc, world);
      try {
        const contextId = await world;
        return {
          frameKey,
          label: where.name || originOf(f.frame),
          sessionId: f.sessionId,
          contextId,
          offset: where.offset,
        };
      } catch {
        tab.worlds.delete(doc); // e.g. the frame went away mid-call; the next observe retries
        return null;
      }
    })
  );
  const kept = handles.filter((h): h is FrameHandle => h !== null);
  kept.forEach((h) => tab.handles.set(h.frameKey, h));
  state.tabs.set(pageSessionId, tab);
  return kept;
}
