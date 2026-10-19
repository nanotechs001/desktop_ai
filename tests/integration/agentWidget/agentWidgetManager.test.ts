/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Rect = { x: number; y: number; width: number; height: number };
type Display = { id: number; bounds: Rect; workArea: Rect };

const h = vi.hoisted(() => ({
  windows: [] as Array<{
    bounds: Rect;
    destroyed: boolean;
    visible: boolean;
    ignoreMouse: boolean;
    emit: (event: string) => void;
  }>,
  displays: [] as Display[],
  cursor: { x: 0, y: 0 },
  screenListeners: {} as Record<string, Array<() => void>>,
  emitted: [] as Array<[string, unknown]>,
  providers: {} as Record<string, (payload: unknown) => Promise<unknown>>,
  /** Display scale factor at screen x (1 everywhere unless a test mixes DPIs). */
  scaleAt: (_x: number) => 1,
}));

vi.mock('electron', () => {
  class BrowserWindow {
    bounds: Rect;
    destroyed = false;
    visible = false;
    ignoreMouse = false;
    focused = false;
    webContents = { send: vi.fn() };
    private handlers: Record<string, Array<() => void>> = {};
    constructor(opts: Rect) {
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      h.windows.push(this);
    }
    on(event: string, fn: () => void) {
      (this.handlers[event] ??= []).push(fn);
      return this;
    }
    once(event: string, fn: () => void) {
      return this.on(event, fn);
    }
    emit(event: string) {
      for (const fn of this.handlers[event] ?? []) fn();
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents(ignore: boolean) {
      this.ignoreMouse = ignore;
    }
    setPosition(x: number, y: number) {
      // Like Windows: moving onto a display with another scale factor rescales the window.
      const k = h.scaleAt(x) / h.scaleAt(this.bounds.x);
      this.bounds = { x, y, width: Math.round(this.bounds.width * k), height: Math.round(this.bounds.height * k) };
    }
    setBounds(b: Rect) {
      this.bounds = { ...b };
    }
    getBounds() {
      return { ...this.bounds };
    }
    isVisible() {
      return this.visible;
    }
    show() {
      this.visible = true;
    }
    showInactive() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {
      this.focused = true;
    }
    isFocused() {
      return this.focused;
    }
    isMinimized() {
      return false;
    }
    restore() {}
  }
  const contains = (d: Display, p: { x: number; y: number }) =>
    p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width && p.y >= d.bounds.y && p.y < d.bounds.y + d.bounds.height;
  const screen = {
    on: (event: string, fn: () => void) => {
      (h.screenListeners[event] ??= []).push(fn);
    },
    removeListener: (event: string, fn: () => void) => {
      h.screenListeners[event] = (h.screenListeners[event] ?? []).filter((f) => f !== fn);
    },
    getAllDisplays: () => h.displays,
    getPrimaryDisplay: () => h.displays[0],
    getDisplayNearestPoint: (p: { x: number; y: number }) => h.displays.find((d) => contains(d, p)) ?? h.displays[0],
    getCursorScreenPoint: () => h.cursor,
  };
  return { BrowserWindow, screen };
});

vi.mock('@/common/adapter/main', () => ({ initMainAdapterWithWindow: () => () => {} }));

vi.mock('@/common', () => {
  const providerNames = [
    'getSettings',
    'setSettings',
    'ensure',
    'hide',
    'listHidden',
    'listRobots',
    'openPopup',
    'remove',
    'getSnapshot',
    'setExpanded',
    'setChatLocation',
    'getChatLocations',
    'handoffDraft',
    'takeDraft',
    'reportState',
    'dragStart',
    'dragMove',
    'dragEnd',
    'landStep',
    'setIgnoreMouse',
    'openInMain',
    'openAgentSettings',
    'openLinkInMain',
    'rendererReady',
    'animationDone',
    'setSuspended',
    'showConversation',
    'broadcastBotColors',
  ];
  const emitterNames = [
    'layoutChanged',
    'chatLocationChanged',
    'draftReady',
    'settingsChanged',
    'lifecycle',
    'retargeted',
    'hiddenChanged',
    'robotsChanged',
    'botColorsChanged',
  ];
  const agentWidget: Record<string, unknown> = {};
  for (const name of providerNames) {
    agentWidget[name] = {
      provider: (fn: (payload: unknown) => Promise<unknown>) => {
        h.providers[name] = fn;
      },
    };
  }
  for (const name of emitterNames) {
    agentWidget[name] = { emit: (data: unknown) => h.emitted.push([name, data]) };
  }
  return { ipcBridge: { agentWidget } };
});

import { AgentWidgetManager } from '@process/pet/agentWidget/agentWidgetManager';
import { initAgentWidgetBridge } from '@process/pet/agentWidget/agentWidgetBridge';
import { normalizeWidgetState } from '@process/pet/agentWidget/agentWidgetStore';
import type { AgentWidgetPersistedState } from '@/common/types/agent/agentWidget';

const BOT = 88;
/** Transparent room above a collapsed robot for its hop; the robot itself still stands on the taskbar edge. */
const HOP_HEADROOM = 12;
const BOTTOM_TASKBAR: Display = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const A = 'conv-a';
const B = 'conv-b';
const C = 'conv-c';

const memoryIO = (initial: unknown) => {
  let saved: unknown = initial;
  return {
    io: {
      read: async () => saved,
      write: async (state: AgentWidgetPersistedState) => {
        saved = structuredClone(state);
      },
    },
    get: () => saved as AgentWidgetPersistedState,
  };
};

const host = {
  preloadPath: '/preload/index.js',
  loadWidget: vi.fn(),
  getMainWindow: vi.fn((): unknown => null),
};
const managers: AgentWidgetManager[] = [];

async function makeManager(initial: unknown = { settings: { enabled: true } }) {
  const mem = memoryIO(initial);
  const manager = new AgentWidgetManager(host, mem.io, () => 0.5);
  managers.push(manager);
  await manager.init();
  return { manager, mem };
}

const liveWindows = () => h.windows.filter((w) => !w.destroyed);
/** The renderer decoded its first frames and played `appearing`: the robot is shown and interactive. */
const appear = (manager: AgentWidgetManager, id: string) => {
  manager.rendererReady(id);
  manager.animationDone(id, 'appearing');
};
const emittedOf = (name: string) => h.emitted.filter(([n]) => n === name).map(([, d]) => d);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  h.windows.length = 0;
  h.emitted.length = 0;
  h.displays = [structuredClone(BOTTOM_TASKBAR)];
  h.cursor = { x: 0, y: 0 };
  h.scaleAt = () => 1;
  h.screenListeners = {};
  host.loadWidget.mockClear();
  host.getMainWindow.mockReturnValue(null);
});

afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  vi.useRealTimers();
});

describe('widget lifecycle', () => {
  it('creates exactly one widget per agent, parked on the taskbar border', async () => {
    const { manager } = await makeManager();
    expect(manager.ensure(A)).toBe(true);
    expect(manager.ensure(A)).toBe(true);
    expect(liveWindows()).toHaveLength(1);
    expect(host.loadWidget).toHaveBeenCalledTimes(1);
    expect(host.loadWidget.mock.calls[0][1]).toBe(A);
    const { bounds } = liveWindows()[0];
    expect(bounds.y + bounds.height).toBe(1040);
    expect(bounds.width).toBe(BOT);
  });

  it('respects the master switch, autoLaunch and a widget the user hid', async () => {
    const off = await makeManager({ settings: { enabled: false } });
    expect(off.manager.ensure(A)).toBe(false);
    expect(liveWindows()).toHaveLength(0);

    const { manager } = await makeManager({ settings: { enabled: true, autoLaunch: false } });
    expect(manager.ensure(A)).toBe(false);
    expect(manager.ensure(A, true)).toBe(true);

    manager.hide(A);
    expect(liveWindows()).toHaveLength(0);
    expect(manager.ensure(A)).toBe(false); // auto-launch never resurrects a hidden widget
    expect(manager.ensure(A, true)).toBe(true);
    expect(liveWindows()).toHaveLength(1);
  });

  it('hiding returns the chat to the main window but keeps the record', async () => {
    const { manager, mem } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    manager.setExpanded(A, true);
    manager.hide(A);
    expect(emittedOf('chatLocationChanged')).toContainEqual({ conversation_id: A, location: 'main' });
    expect(mem.get().widgets[A]).toMatchObject({ hidden: true, chat_location: 'main' });
  });

  it('cleans up window, draft and saved state when the agent is deleted', async () => {
    const { manager, mem } = await makeManager();
    manager.ensure(A);
    manager.ensure(B);
    manager.handoffDraft(A, 'unsent');
    manager.remove(A);
    expect(liveWindows()).toHaveLength(1);
    expect(mem.get().widgets[A]).toBeUndefined();
    expect(manager.getSnapshot(A)).toBeNull();
    expect(manager.takeDraft(A)).toBe('');
    expect(manager.getSnapshot(B)).not.toBeNull();
  });

  it('closing all windows (main window closed) keeps records; re-enable restores them', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.ensure(B);
    manager.setSettings({ enabled: false });
    expect(liveWindows()).toHaveLength(0);
    expect(emittedOf('settingsChanged').at(-1)).toMatchObject({ enabled: false });
    manager.setSettings({ enabled: true });
    expect(liveWindows()).toHaveLength(2);
  });
});

describe('restoration after restart', () => {
  it('restores the same widget ↔ conversation mapping and positions, never hidden ones', async () => {
    const first = await makeManager();
    first.manager.ensure(A);
    first.manager.ensure(B);
    first.manager.hide(B);
    const widgetIdA = first.manager.getSnapshot(A)?.record.widget_id;
    appear(first.manager, A);

    // Drag A to x≈300.
    const startX = liveWindows()[0].bounds.x;
    h.cursor = { x: startX + 10, y: 1000 };
    first.manager.dragStart(A);
    h.cursor = { x: 310, y: 1000 };
    vi.advanceTimersByTime(20);
    first.manager.dragEnd(A);
    vi.advanceTimersByTime(1_000); // drop-landing plays out
    expect(liveWindows()[0].bounds.x).toBe(300);
    first.manager.dispose();

    const second = await makeManager(first.mem.get());
    expect(liveWindows()).toHaveLength(1);
    const snapshot = second.manager.getSnapshot(A);
    expect(snapshot?.record.widget_id).toBe(widgetIdA);
    expect(snapshot?.record.expanded).toBe(false);
    expect(liveWindows()[0].bounds.x).toBe(300);
    expect(second.manager.getSnapshot(B)).toBeNull();
  });
});

describe('routing between agents', () => {
  it('moves only the clicked agent’s chat into its widget and hands drafts over', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.ensure(B);
    const [winA, winB] = liveWindows();
    appear(manager, A);

    manager.setExpanded(A, true);
    expect(emittedOf('chatLocationChanged')).toEqual([{ conversation_id: A, location: 'widget' }]);
    expect(manager.getChatLocations()).toEqual({ [A]: 'widget' });
    expect(winA.bounds.height).toBeGreaterThan(BOT);
    expect(winB.bounds.height).toBe(BOT + HOP_HEADROOM);

    manager.handoffDraft(A, 'half-typed');
    expect(emittedOf('draftReady')).toEqual([{ conversation_id: A, to: 'widget' }]);
    expect(manager.takeDraft(A)).toBe('half-typed');
    expect(manager.takeDraft(A)).toBe('');

    manager.setChatLocation(A, 'main');
    expect(winA.bounds.height).toBe(BOT + HOP_HEADROOM); // returning the chat collapses the popup
    expect(manager.getChatLocations()).toEqual({});
  });

  it('keeps several robots apart on the same taskbar', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.ensure(B);
    manager.ensure(C);
    const xs = liveWindows().map((w) => w.bounds.x);
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) expect(Math.abs(xs[i] - xs[j])).toBeGreaterThanOrEqual(BOT * 1.25 - 1);
    }
  });
});

describe('display changes and movement', () => {
  it('re-seats robots when the taskbar moves to the top', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    h.displays = [{ ...BOTTOM_TASKBAR, workArea: { x: 0, y: 40, width: 1920, height: 1040 } }];
    for (const fn of h.screenListeners['display-metrics-changed'] ?? []) fn();
    expect(liveWindows()[0].bounds.y).toBe(40);
  });

  it('wanders only while idle and collapsed, and never with reduce motion', async () => {
    const { manager } = await makeManager({ settings: { enabled: true, movementFrequency: 'high' } });
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    const x0 = win.bounds.x;

    manager.reportState(A, 'working');
    vi.advanceTimersByTime(45_000);
    expect(win.bounds.x).toBe(x0);

    manager.reportState(A, 'idle');
    vi.advanceTimersByTime(45_000);
    vi.advanceTimersByTime(5_000);
    expect(win.bounds.x).not.toBe(x0);

    const x1 = win.bounds.x;
    manager.setSettings({ reduceMotion: true });
    vi.advanceTimersByTime(120_000);
    expect(win.bounds.x).toBe(x1);
  });
});

type LayoutEvent = { conversation_id: string; facing: 'left' | 'right'; moving: boolean; hop_headroom: number };
const lastLayout = (id: string) =>
  (emittedOf('layoutChanged') as LayoutEvent[]).filter((l) => l.conversation_id === id).at(-1);

/** A manager whose robots wander often ('high'), with `random` picking timing, direction and distance. */
async function wanderingManager(random: number) {
  const mem = memoryIO({ settings: { enabled: true, movementFrequency: 'high' } });
  const manager = new AgentWidgetManager(host, mem.io, () => random);
  managers.push(manager);
  await manager.init();
  return manager;
}

describe('following the mouse along the taskbar', () => {
  // Robot A starts at x=1557 (centre 1601) on a 1920-wide display; y=500 keeps the cursor off the robot.
  const mouseAt = (x: number) => {
    h.cursor = { x, y: 500 };
  };

  it('faces the mouse while standing still, without moving', async () => {
    const manager = await wanderingManager(0.5);
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    const x0 = win.bounds.x;
    mouseAt(200);
    vi.advanceTimersByTime(1_000);
    expect(lastLayout(A)).toMatchObject({ facing: 'left', moving: false });
    expect(win.bounds.x).toBe(x0);
    mouseAt(1900);
    vi.advanceTimersByTime(1_000);
    expect(lastLayout(A)?.facing).toBe('right');
    mouseAt(1601 + 10); // within the dead zone: no flip back and forth
    vi.advanceTimersByTime(1_000);
    expect(lastLayout(A)?.facing).toBe('right');
  });

  it('11/7. strolls toward a mouse on the right, facing right, at the unchanged speed (2 px per 50 ms)', async () => {
    const manager = await wanderingManager(0.5); // first stroll at 7.5 s, 100 px
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    mouseAt(1900);
    vi.advanceTimersByTime(8_000);
    expect(lastLayout(A)).toMatchObject({ facing: 'right', moving: true, hop_headroom: HOP_HEADROOM });
    const x0 = win.bounds.x;
    vi.advanceTimersByTime(500);
    expect(win.bounds.x - x0).toBe(20);
  });

  it('8. strolls toward a mouse on the left, mirrored, at the same speed', async () => {
    const manager = await wanderingManager(0.2); // first stroll at 6 s, 64 px
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    mouseAt(200);
    vi.advanceTimersByTime(1_000);
    expect(lastLayout(A)).toMatchObject({ facing: 'left', moving: false }); // turned toward the mouse first
    const x0 = win.bounds.x;
    vi.advanceTimersByTime(5_000);
    expect(lastLayout(A)).toMatchObject({ facing: 'left', moving: true });
    vi.advanceTimersByTime(500);
    expect(x0 - win.bounds.x).toBe(20);
  });

  it('walks in random-interval strolls until it stands under the mouse, then rests', async () => {
    const manager = await wanderingManager(0.5);
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    mouseAt(1200 + 44); // target x = 1200
    vi.advanceTimersByTime(120_000);
    expect(Math.abs(win.bounds.x - 1200)).toBeLessThanOrEqual(24);
    const rested = win.bounds.x;
    vi.advanceTimersByTime(60_000);
    expect(win.bounds.x).toBe(rested);
  });

  it('stays put when the mouse is on another monitor', async () => {
    h.displays = [
      structuredClone(BOTTOM_TASKBAR),
      {
        id: 2,
        bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
        workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
      },
    ];
    const manager = await wanderingManager(0.5);
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    const x0 = win.bounds.x;
    mouseAt(3000);
    vi.advanceTimersByTime(60_000);
    expect(win.bounds.x).toBe(x0);
  });

  it('13/14. every stroll ends with the robot exactly on the taskbar edge', async () => {
    const manager = await wanderingManager(0.5);
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    mouseAt(1601 + 100); // exactly one 100 px stroll away: it arrives and rests
    vi.advanceTimersByTime(8_000 + 3_000); // a 100 px stroll at 40 px/s takes 2.5 s
    expect(lastLayout(A)).toMatchObject({ moving: false });
    expect(win.bounds.y + win.bounds.height).toBe(1040); // robot bottom = taskbar top, never inside it
  });

  it('17. falling asleep mid-stroll lands cleanly before sleeping', async () => {
    const manager = await wanderingManager(0.5);
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    mouseAt(1900);
    vi.advanceTimersByTime(8_000 + 300);
    expect(lastLayout(A)?.moving).toBe(true);
    manager.reportState(A, 'sleeping');
    expect(lastLayout(A)?.moving).toBe(false);
    const x = win.bounds.x;
    vi.advanceTimersByTime(60_000);
    expect(win.bounds.x).toBe(x);
    expect(win.bounds.y + win.bounds.height).toBe(1040);
  });

  it('6. stays put while the chat is open or a turn transition is playing', async () => {
    const manager = await wanderingManager(0.5);
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    mouseAt(200);
    manager.setExpanded(A, true);
    const x = win.bounds.x;
    vi.advanceTimersByTime(60_000);
    expect(win.bounds.x).toBe(x);
    manager.setExpanded(A, false);
    manager.reportState(A, 'idle', true); // turning away
    const xc = win.bounds.x;
    vi.advanceTimersByTime(60_000);
    expect(win.bounds.x).toBe(xc);
  });

  it('21. widgets follow and face independently', async () => {
    const manager = await wanderingManager(0.5);
    manager.ensure(A);
    manager.ensure(B);
    const [winA, winB] = liveWindows();
    appear(manager, A);
    appear(manager, B);
    manager.reportState(B, 'working');
    mouseAt(1900);
    const xB = winB.bounds.x;
    vi.advanceTimersByTime(8_000 + 300);
    expect(lastLayout(A)?.moving).toBe(true);
    expect(lastLayout(B)?.moving ?? false).toBe(false);
    expect(winB.bounds.x).toBe(xB);
  });
});

type DragLayout = LayoutEvent & { drag_phase: 'none' | 'dragging' | 'landing' };
const lastDragPhase = (id: string) => (lastLayout(id) as DragLayout | undefined)?.drag_phase;
const lifecycleOf = (id: string) =>
  (emittedOf('lifecycle') as Array<{ conversation_id: string; animation: string }>)
    .filter((e) => e.conversation_id === id)
    .map((e) => e.animation);
// Bottom taskbar fixtures: the robot box stands at y=952 (1040 - 88) inside a window with 12 px hop headroom.
const TRACK_Y = 1040 - BOT;
const robotTop = (win: { bounds: Rect }) => win.bounds.y + HOP_HEADROOM;
// Linux cannot toggle click-through (no mouse forwarding), so the manager never calls it there.
const canIgnoreMouse = process.platform !== 'linux';

describe('appearing and disappearing', () => {
  it('7–8. a new widget stays hidden until its first frames are ready, then plays appearing once', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    const win = liveWindows()[0];
    expect(win.visible).toBe(false);
    expect(lifecycleOf(A)).toEqual([]);

    manager.rendererReady(A);
    expect(win.visible).toBe(true);
    expect(lifecycleOf(A)).toEqual(['appearing']);
    expect(win.bounds.y + win.bounds.height).toBe(1040); // materializes at its final taskbar spot
    if (canIgnoreMouse) expect(win.ignoreMouse).toBe(true);
    manager.setExpanded(A, true); // no popup while materializing
    expect(manager.getSnapshot(A)?.layout.expanded).toBe(false);

    manager.animationDone(A, 'appearing');
    if (canIgnoreMouse) expect(win.ignoreMouse).toBe(false);
    manager.setExpanded(A, true);
    expect(manager.getSnapshot(A)?.layout.expanded).toBe(true);
    expect(lifecycleOf(A)).toEqual(['appearing']); // opening the popup never replays it
  });

  it('shows the window anyway when the renderer never reports in', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    const win = liveWindows()[0];
    win.emit('ready-to-show');
    vi.advanceTimersByTime(8_000);
    expect(win.visible).toBe(true);
    expect(lifecycleOf(A)).toEqual(['appearing']);
    vi.advanceTimersByTime(2_000); // appearing never reported: stop waiting
    manager.setExpanded(A, true);
    expect(manager.getSnapshot(A)?.layout.expanded).toBe(true);
  });

  it('a renderer that reports in after the fallback showed it still gets to play appearing', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    liveWindows()[0].emit('ready-to-show');
    vi.advanceTimersByTime(8_000); // shown by the fallback; the renderer was not listening yet
    manager.rendererReady(A);
    expect(lifecycleOf(A)).toEqual(['appearing', 'appearing']);
  });

  it('a reloaded robot page reports again and plays appearing again instead of freezing', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    manager.rendererReady(A); // the page reloaded (dev hot reload, crash recovery)
    expect(lifecycleOf(A)).toEqual(['appearing', 'appearing']);
  });

  it('restored widgets play appearing after startup too', async () => {
    const first = await makeManager();
    first.manager.ensure(A);
    first.manager.dispose();
    h.emitted.length = 0;
    const second = await makeManager(first.mem.get());
    second.manager.rendererReady(A);
    expect(lifecycleOf(A)).toEqual(['appearing']);
  });

  it('16. hiding plays disappearing before the window goes', async () => {
    const { manager, mem } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    const win = liveWindows()[0];
    manager.hide(A);
    expect(lifecycleOf(A)).toEqual(['appearing', 'disappearing']);
    expect(win.destroyed).toBe(false);
    if (canIgnoreMouse) expect(win.ignoreMouse).toBe(true);
    expect(mem.get().widgets[A]).toMatchObject({ hidden: true });
    manager.animationDone(A, 'disappearing');
    expect(win.destroyed).toBe(true);
  });

  it('removes the window after the animation time even if the renderer never reports', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    manager.hide(A);
    vi.advanceTimersByTime(500);
    expect(liveWindows()).toHaveLength(1);
    vi.advanceTimersByTime(1_500);
    expect(liveWindows()).toHaveLength(0);
  });

  it('17. deleting the agent plays disappearing, then cleans up', async () => {
    const { manager, mem } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    manager.remove(A);
    expect(lifecycleOf(A).at(-1)).toBe('disappearing');
    expect(mem.get().widgets[A]).toBeUndefined();
    expect(manager.getSnapshot(A)).toBeNull();
    expect(liveWindows()).toHaveLength(1);
    manager.animationDone(A, 'disappearing');
    expect(liveWindows()).toHaveLength(0);
  });

  it('18. closing only the chat popup never plays disappearing', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    manager.setExpanded(A, true);
    manager.setExpanded(A, false);
    manager.setChatLocation(A, 'main');
    expect(lifecycleOf(A)).toEqual(['appearing']);
  });

  it('turning widget mode off plays disappearing for every robot', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    manager.setSettings({ enabled: false });
    expect(lifecycleOf(A).at(-1)).toBe('disappearing');
    manager.animationDone(A, 'disappearing');
    expect(liveWindows()).toHaveLength(0);
  });

  it('showing a widget again while it vanishes replaces the old window', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    manager.hide(A);
    expect(manager.ensure(A, true)).toBe(true);
    expect(liveWindows()).toHaveLength(1);
    expect(manager.getSnapshot(A)).not.toBeNull();
  });
});

describe('showing hidden robots again', () => {
  it('lists the robots the user hid and announces each change', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, 'bot-1');
    manager.ensure(B, false, 'bot-2');
    expect(manager.listHidden()).toEqual([]);

    manager.hide(A);
    expect(manager.listHidden()).toEqual([{ conversation_id: A, agent_id: 'bot-1' }]);
    expect(emittedOf('hiddenChanged').at(-1)).toEqual([{ conversation_id: A, agent_id: 'bot-1' }]);

    expect(manager.ensure(A, true, 'bot-1')).toBe(true);
    expect(manager.listHidden()).toEqual([]);
    expect(emittedOf('hiddenChanged').at(-1)).toEqual([]);
    expect(liveWindows()).toHaveLength(2);
  });

  it('showing a bot again from another of its chats moves the hidden robot there', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, 'bot-1');
    manager.hide(A);
    expect(manager.ensure(B, true, 'bot-1')).toBe(true);
    expect(manager.listHidden()).toEqual([]);
    expect(manager.getSnapshot(B)?.record).toMatchObject({ conversation_id: B, hidden: false });
    expect(emittedOf('hiddenChanged').at(-1)).toEqual([]);
  });

  it('a hidden robot whose chat is removed leaves the list', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.hide(A);
    manager.remove(A);
    expect(manager.listHidden()).toEqual([]);
    expect(emittedOf('hiddenChanged').at(-1)).toEqual([]);
  });

  it('lists hidden robots over IPC', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    manager.ensure(A);
    manager.hide(A);
    await expect(h.providers.listHidden(undefined)).resolves.toEqual([{ conversation_id: A, agent_id: undefined }]);
  });
});

describe('the titlebar robot list', () => {
  it('lists every robot, visible and hidden', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    manager.ensure(A, false, 'bot-1');
    manager.ensure(B, false, 'bot-2');
    manager.hide(B);
    const robots = [
      { conversation_id: A, agent_id: 'bot-1', hidden: false },
      { conversation_id: B, agent_id: 'bot-2', hidden: true },
    ];
    expect(manager.listRobots()).toEqual(robots);
    await expect(h.providers.listRobots(undefined)).resolves.toEqual(robots);
  });

  it('announces the list on create, hide, show, remove and retarget', async () => {
    const { manager } = await makeManager();
    const last = () => emittedOf('robotsChanged').at(-1);
    manager.ensure(A, false, 'bot-1');
    expect(last()).toEqual([{ conversation_id: A, agent_id: 'bot-1', hidden: false }]);
    manager.hide(A);
    expect(last()).toEqual([{ conversation_id: A, agent_id: 'bot-1', hidden: true }]);
    manager.ensure(A, true, 'bot-1');
    expect(last()).toEqual([{ conversation_id: A, agent_id: 'bot-1', hidden: false }]);
    manager.retarget(A, B);
    expect(last()).toEqual([{ conversation_id: B, agent_id: 'bot-1', hidden: false }]);
    manager.remove(B);
    expect(last()).toEqual([]);
    expect(emittedOf('robotsChanged')).toHaveLength(5);
  });

  it('opening the popup of a hidden robot shows it and expands it once it has fully appeared', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    manager.ensure(A, false, 'bot-1');
    manager.hide(A);
    await expect(h.providers.openPopup({ conversation_id: A, agent_id: 'bot-1' })).resolves.toBe(true);
    expect(manager.listHidden()).toEqual([]);
    manager.rendererReady(A);
    expect(manager.getSnapshot(A)?.layout.expanded).toBe(false); // still appearing
    manager.animationDone(A, 'appearing');
    expect(manager.getSnapshot(A)?.layout.expanded).toBe(true);
    expect(manager.getChatLocations()).toEqual({ [A]: 'widget' });
  });

  it('a pending popup is dropped when the chat goes back to the main window first', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, 'bot-1');
    manager.hide(A);
    manager.openPopup(A, 'bot-1');
    manager.setChatLocation(A, 'main'); // Watch, before the robot has appeared
    appear(manager, A);
    expect(manager.getSnapshot(A)?.layout.expanded).toBe(false);
  });

  it('a pending popup is dropped when the robot disappears before it is live', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, 'bot-1');
    manager.hide(A);
    manager.openPopup(A, 'bot-1');
    manager.rendererReady(A); // appearing
    manager.setSuspended(A, true);
    manager.animationDone(A, 'disappearing');
    manager.setSuspended(A, false);
    manager.animationDone(A, 'appearing');
    expect(manager.getSnapshot(A)?.layout.expanded).toBe(false);
  });

  it('opening the popup of a robot already on the desktop expands it at once', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, 'bot-1');
    appear(manager, A);
    expect(manager.openPopup(A, 'bot-1')).toBe(true);
    expect(manager.getSnapshot(A)?.layout.expanded).toBe(true);
  });

  it('rejects a malformed openPopup request', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    await expect(h.providers.openPopup({ conversation_id: '../x' })).rejects.toThrow();
    await expect(h.providers.openPopup({ conversation_id: A, extra: 1 })).rejects.toThrow();
  });
});

describe('one robot per VA Bot', () => {
  const BOT_ID = 'bot-1';

  it('a new conversation of the same bot moves its robot over: no second robot, no replayed appearing', async () => {
    const { manager, mem } = await makeManager();
    manager.ensure(A, false, BOT_ID);
    appear(manager, A);
    const win = liveWindows()[0];

    expect(manager.ensure(B, false, BOT_ID)).toBe(true);
    expect(liveWindows()).toEqual([win]);
    expect(emittedOf('retargeted')).toEqual([{ conversation_id: A, to: B }]);
    expect(lifecycleOf(A)).toEqual(['appearing']);
    expect(manager.getSnapshot(A)).toBeNull();
    expect(manager.getSnapshot(B)?.record).toMatchObject({ conversation_id: B, agent_id: BOT_ID });
    expect(Object.keys(mem.get().widgets)).toEqual([B]);
  });

  it('different bots keep their own robots', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, BOT_ID);
    manager.ensure(B, false, 'bot-2');
    expect(liveWindows()).toHaveLength(2);
  });

  it('a bot whose robot the user hid stays hidden on its next conversation', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, BOT_ID);
    manager.hide(A);
    expect(manager.ensure(B, false, BOT_ID)).toBe(false);
    expect(liveWindows()).toHaveLength(0);
  });

  it('robots saved per conversation collapse to the newest conversation of each bot', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.ensure(B);
    appear(manager, A);
    manager.rendererReady(A, { agent_id: BOT_ID, modified_at: 100 });
    manager.rendererReady(B, { agent_id: BOT_ID, modified_at: 200 });
    expect(lifecycleOf(A).at(-1)).toBe('disappearing'); // the older one vanishes
    manager.animationDone(A, 'disappearing');
    expect(liveWindows()).toHaveLength(1);
    expect(manager.getSnapshot(B)).not.toBeNull();
  });

  it('picking a conversation from the bot history keeps the popup open on it', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, BOT_ID);
    appear(manager, A);
    manager.setExpanded(A, true);
    manager.retarget(A, B);
    expect(manager.getSnapshot(B)?.layout.expanded).toBe(true);
    expect(manager.getChatLocations()).toEqual({ [B]: 'widget' });
    expect(emittedOf('chatLocationChanged')).toContainEqual({ conversation_id: A, location: 'main' });
  });
});

describe('stepping away while the chat is open in the main window', () => {
  it('disappears while suspended and appears again when released, without touching the saved record', async () => {
    const { manager, mem } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    const win = liveWindows()[0];
    manager.setSuspended(A, true);
    expect(lifecycleOf(A)).toEqual(['appearing', 'disappearing']);
    manager.animationDone(A, 'disappearing');
    expect(win.visible).toBe(false);
    expect(win.destroyed).toBe(false);
    expect(mem.get().widgets[A].hidden).toBe(false);

    manager.setSuspended(A, false);
    expect(win.visible).toBe(true);
    expect(lifecycleOf(A)).toEqual(['appearing', 'disappearing', 'appearing']);
  });

  it('a robot suspended before it ever showed stays hidden until released', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.setSuspended(A, true);
    manager.rendererReady(A);
    const win = liveWindows()[0];
    expect(win.visible).toBe(false);
    expect(lifecycleOf(A)).toEqual([]);
    manager.setSuspended(A, false);
    expect(win.visible).toBe(true);
    expect(lifecycleOf(A)).toEqual(['appearing']);
  });
});

describe('dragging and drop-landing', () => {
  async function liveRobot(settings: Record<string, unknown> = {}) {
    const made = await makeManager({ settings: { enabled: true, movementFrequency: 'high', ...settings } });
    made.manager.ensure(A);
    appear(made.manager, A);
    return { ...made, win: liveWindows()[0] };
  }
  const pick = (manager: AgentWidgetManager, win: { bounds: Rect }) => {
    h.cursor = { x: win.bounds.x + 40, y: robotTop(win) + 30 }; // grabbed off-centre
    manager.dragStart(A);
  };

  it('10–11. carries the robot with the pointer, keeping the grab offset, and stops walking meanwhile', async () => {
    const { manager, win } = await liveRobot();
    pick(manager, win);
    expect(lastDragPhase(A)).toBe('dragging');
    expect(lastLayout(A)?.moving).toBe(false);
    h.cursor = { x: 800, y: 500 };
    vi.advanceTimersByTime(20);
    expect(win.bounds.x).toBe(760);
    expect(robotTop(win)).toBe(470);
    h.cursor = { x: 300, y: 500 }; // the mouse is far away, but nothing wanders during a drag
    vi.advanceTimersByTime(20);
    const x = win.bounds.x;
    vi.advanceTimersByTime(5_000);
    expect(win.bounds.x).toBe(x);
    expect(lastLayout(A)?.moving).toBe(false);
  });

  it('follows each pointer move at once, without waiting for a timer tick', async () => {
    const { manager, win } = await liveRobot();
    pick(manager, win);
    h.cursor = { x: 800, y: 500 };
    manager.dragMove(A);
    expect(win.bounds.x).toBe(760);
    expect(robotTop(win)).toBe(470);
    h.cursor = { x: 803, y: 502 };
    manager.dragMove(A);
    expect(win.bounds.x).toBe(763);
    expect(robotTop(win)).toBe(472);
  });

  it('the fallback timer stays out of the way while pointer moves keep arriving', async () => {
    const { manager, win } = await liveRobot();
    pick(manager, win);
    h.cursor = { x: 800, y: 500 };
    manager.dragMove(A);
    h.cursor = { x: 900, y: 500 }; // no pointer move reported for this position yet
    vi.advanceTimersByTime(20);
    expect(win.bounds.x).toBe(760);
    vi.advanceTimersByTime(60); // pointer moves went quiet: the timer catches up
    expect(win.bounds.x).toBe(860);
  });

  it('pointer moves keep a long drag alive past the watchdog', async () => {
    const { manager, win } = await liveRobot();
    pick(manager, win);
    for (let i = 0; i < 12; i++) {
      h.cursor = { x: 600 + i, y: 400 };
      manager.dragMove(A);
      vi.advanceTimersByTime(1_000);
    }
    expect(lastDragPhase(A)).toBe('dragging');
    manager.dragEnd(A);
    expect(lastDragPhase(A)).toBe('landing');
  });

  it('14. a carried robot never goes into the taskbar', async () => {
    const { manager, win } = await liveRobot();
    pick(manager, win);
    h.cursor = { x: 800, y: 1075 };
    vi.advanceTimersByTime(20);
    expect(robotTop(win) + BOT).toBeLessThanOrEqual(1040);
  });

  it('12–15. release plays drop-landing: falls onto the exact taskbar base, never past it, and saves the spot', async () => {
    const { manager, mem, win } = await liveRobot();
    pick(manager, win);
    h.cursor = { x: 800, y: 300 };
    vi.advanceTimersByTime(20);
    const releasedTop = robotTop(win);
    const x = win.bounds.x;
    manager.dragEnd(A);
    expect(lastDragPhase(A)).toBe('landing');
    expect(mem.get().widgets[A].x_ratio).toBeCloseTo(x / (1920 - BOT), 3);

    const tops: number[] = [];
    for (let t = 0; t < 700; t += 16) {
      vi.advanceTimersByTime(16);
      tops.push(robotTop(win));
      expect(win.bounds.x).toBe(x); // horizontal position stays put while landing
      expect(robotTop(win) + BOT).toBeLessThanOrEqual(1040);
    }
    expect(tops[0]).toBeGreaterThanOrEqual(releasedTop);
    expect(tops[0]).toBeLessThan(TRACK_Y);
    expect(tops.slice(1).every((top, i) => top >= tops[i])).toBe(true); // only ever falls
    // Touches down by the impact frame (360 ms), then rests while the landing frames finish.
    expect(tops[Math.ceil(360 / 16)]).toBe(TRACK_Y);

    vi.advanceTimersByTime(100);
    expect(lastDragPhase(A)).toBe('none');
    expect(robotTop(win)).toBe(TRACK_Y);
    expect(win.bounds.y + win.bounds.height).toBe(1040);
  });

  it('each renderer frame steps the fall at once; the timer stays out of the way meanwhile', async () => {
    const { manager, win } = await liveRobot();
    pick(manager, win);
    h.cursor = { x: 800, y: 300 };
    manager.dragMove(A);
    const releasedTop = robotTop(win);
    manager.dragEnd(A);

    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(15); // frames arrive faster than the fallback considers them quiet
      manager.landStep(A);
    }
    const afterFrames = robotTop(win);
    expect(afterFrames).toBeGreaterThan(releasedTop);

    vi.advanceTimersByTime(16); // a timer tick right after a frame step does nothing
    expect(robotTop(win)).toBe(afterFrames);

    vi.advanceTimersByTime(100); // frames stopped: the fallback timer carries on with the fall
    expect(robotTop(win)).toBeGreaterThan(afterFrames);
    vi.advanceTimersByTime(1_000);
    expect(lastDragPhase(A)).toBe('none');
    expect(robotTop(win)).toBe(TRACK_Y);
  });

  it('a frame step outside a fall does nothing', async () => {
    const { manager, win } = await liveRobot();
    const before = { ...win.bounds };
    manager.landStep(A);
    expect(win.bounds).toEqual(before);
    expect(lastDragPhase(A) ?? 'none').toBe('none');
  });

  it('does not stroll off right after landing', async () => {
    const { manager, win } = await liveRobot();
    pick(manager, win);
    manager.dragEnd(A);
    vi.advanceTimersByTime(800);
    h.cursor = { x: 100, y: 500 };
    vi.advanceTimersByTime(1_000);
    expect(lastLayout(A)?.moving).toBe(false);
  });

  it('a cancelled drag (watchdog) still lands', async () => {
    const { manager, win } = await liveRobot();
    pick(manager, win);
    h.cursor = { x: 800, y: 300 };
    vi.advanceTimersByTime(8_000 + 1_000);
    expect(lastDragPhase(A)).toBe('none');
    expect(robotTop(win)).toBe(TRACK_Y);
  });

  it('23. reduce motion skips the fall and puts the robot straight back on the taskbar', async () => {
    const { manager, win } = await liveRobot({ reduceMotion: true });
    pick(manager, win);
    h.cursor = { x: 800, y: 300 };
    vi.advanceTimersByTime(20);
    manager.dragEnd(A);
    expect(lastDragPhase(A)).toBe('none');
    expect(robotTop(win)).toBe(TRACK_Y);
  });

  it('20. dragging one robot leaves the others alone', async () => {
    const { manager, win } = await liveRobot();
    manager.ensure(B);
    appear(manager, B);
    const winB = liveWindows()[1];
    const before = { ...winB.bounds };
    pick(manager, win);
    h.cursor = { x: 300, y: 300 };
    vi.advanceTimersByTime(20);
    expect(lastDragPhase(B) ?? 'none').toBe('none');
    expect(winB.bounds).toEqual(before);
  });

  it('a robot that is still appearing cannot be dragged', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.rendererReady(A);
    manager.dragStart(A);
    expect(lastDragPhase(A) ?? 'none').toBe('none');
  });
});

describe('monitors with different scaling', () => {
  it('dragging back and forth between a 125% laptop and a 100% monitor never sinks the robot', async () => {
    // Laptop (display 2, 125%) on the left, main monitor (display 1, 100%) on the right.
    h.displays = [
      {
        id: 1,
        bounds: { x: 1536, y: 0, width: 3440, height: 1440 },
        workArea: { x: 1536, y: 0, width: 3440, height: 1392 },
      },
      { id: 2, bounds: { x: 0, y: 0, width: 1536, height: 960 }, workArea: { x: 0, y: 0, width: 1536, height: 912 } },
    ];
    h.scaleAt = (x) => (x < 1536 ? 1.25 : 1);
    const { manager } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    const win = liveWindows()[0];
    const dropAt = (x: number) => {
      h.cursor = { x: win.bounds.x + 40, y: win.bounds.y + HOP_HEADROOM + 30 };
      manager.dragStart(A);
      h.cursor = { x, y: 300 };
      vi.advanceTimersByTime(20);
      manager.dragEnd(A);
      vi.advanceTimersByTime(1_000);
    };
    for (let i = 0; i < 3; i++) {
      dropAt(700); // laptop
      expect(win.bounds.height).toBe(BOT + HOP_HEADROOM);
      expect(win.bounds.y + win.bounds.height).toBe(912);
      dropAt(3000); // monitor
      expect(win.bounds.height).toBe(BOT + HOP_HEADROOM);
      expect(win.bounds.y + win.bounds.height).toBe(1392);
    }
  });
});

describe('IPC boundary', () => {
  it('rejects malformed widget messages and clamps settings', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    await expect(h.providers.ensure({ conversation_id: '../../etc' })).rejects.toThrow();
    await expect(h.providers.ensure({ conversation_id: A, extra: true })).rejects.toThrow();
    await expect(h.providers.reportState({ conversation_id: A, state: 'dancing' })).rejects.toThrow();
    await expect(h.providers.setSettings({ enabled: 'yes' })).rejects.toThrow();
    await expect(h.providers.handoffDraft({ conversation_id: A, text: 'x'.repeat(100_001) })).rejects.toThrow();
    expect(liveWindows()).toHaveLength(0);

    await expect(h.providers.ensure({ conversation_id: A })).resolves.toBe(true);
    await expect(h.providers.setSettings({ scale: 99 })).resolves.toMatchObject({ scale: 1.5 });
  });
});

describe("opening a VA Bot's settings in the main window", () => {
  const makeMain = () => ({
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  });

  it('brings the main window forward and tells it which bot, leaving the chat where it is', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.setChatLocation(A, 'widget');
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);

    manager.openAgentSettings('bot-1');

    expect(main.restore).toHaveBeenCalled();
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
    expect(main.webContents.send).toHaveBeenCalledWith('tray:open-agent-settings', { agent_id: 'bot-1' });
    expect(manager.getChatLocations()[A]).toBe('widget');
  });

  it('does nothing without a main window', async () => {
    const { manager } = await makeManager();
    expect(() => manager.openAgentSettings('bot-1')).not.toThrow();
  });

  it('rejects a request without an agent_id at the IPC boundary', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);
    await expect(h.providers.openAgentSettings({ conversation_id: A })).rejects.toThrow();
    await expect(h.providers.openAgentSettings({ conversation_id: A, agent_id: '' })).rejects.toThrow();
    await expect(h.providers.openAgentSettings({ conversation_id: A, agent_id: 'b', extra: 1 })).rejects.toThrow();
    expect(main.webContents.send).not.toHaveBeenCalled();
    await expect(h.providers.openAgentSettings({ conversation_id: A, agent_id: 'bot-1' })).resolves.toBeUndefined();
    expect(main.webContents.send).toHaveBeenCalledWith('tray:open-agent-settings', { agent_id: 'bot-1' });
  });
});

describe("opening a robot chat's link in the main window", () => {
  const makeMain = () => ({
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  });
  const URL_IN_CHAT = 'https://example.com/page?q=1';

  it('brings the main window forward, keeps the chat in its popup and sends the link with its conversation', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.setChatLocation(A, 'widget');
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);

    manager.openLinkInMain(A, URL_IN_CHAT);

    expect(main.restore).toHaveBeenCalled();
    expect(main.show).toHaveBeenCalled();
    expect(main.focus).toHaveBeenCalled();
    expect(main.webContents.send).toHaveBeenCalledWith('tray:open-link-in-conversation', {
      conversation_id: A,
      url: URL_IN_CHAT,
    });
    expect(manager.getChatLocations()[A]).toBe('widget');
  });

  it('does nothing without a main window', async () => {
    const { manager } = await makeManager();
    expect(() => manager.openLinkInMain(A, URL_IN_CHAT)).not.toThrow();
  });

  it('rejects a non-http(s) url or a malformed payload at the IPC boundary', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'chrome://settings',
      'not a url',
      '',
      'ftp://x.com',
    ]) {
      await expect(h.providers.openLinkInMain({ conversation_id: A, url })).rejects.toThrow();
    }
    await expect(h.providers.openLinkInMain({ conversation_id: A })).rejects.toThrow();
    await expect(h.providers.openLinkInMain({ conversation_id: '../x', url: URL_IN_CHAT })).rejects.toThrow();
    await expect(h.providers.openLinkInMain({ conversation_id: A, url: URL_IN_CHAT, extra: 1 })).rejects.toThrow();
    expect(main.webContents.send).not.toHaveBeenCalled();
    await expect(h.providers.openLinkInMain({ conversation_id: A, url: URL_IN_CHAT })).resolves.toBeUndefined();
    expect(main.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('the manager refuses a non-http(s) url too', async () => {
    const { manager } = await makeManager();
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);
    manager.openLinkInMain(A, 'file:///etc/passwd');
    expect(main.show).not.toHaveBeenCalled();
    expect(main.webContents.send).not.toHaveBeenCalled();
  });
});

describe('Agent color broadcast', () => {
  it('re-emits a valid color map to every window', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    const colors = { 'bot-1': '#3B82F6', 'bot-2': '#10b981' };
    await expect(h.providers.broadcastBotColors(colors)).resolves.toBeUndefined();
    expect(emittedOf('botColorsChanged')).toEqual([colors]);
  });

  it('rejects anything that is not a map of #rrggbb colors, emitting nothing', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    for (const bad of [
      null,
      'red',
      [],
      { a: 'red' },
      { a: '#12345' },
      { a: 'url(x)' },
      { a: '#112233; background: red' },
      { a: 5 },
      { '': '#112233' },
    ]) {
      await expect(h.providers.broadcastBotColors(bad)).rejects.toThrow();
    }
    expect(emittedOf('botColorsChanged')).toEqual([]);
  });
});

describe('persisted state normalization', () => {
  it('drops invalid records and unknown settings, and never restores an open popup', () => {
    const state = normalizeWidgetState({
      settings: { enabled: true, scale: 0.1, legacyFlag: 1, alwaysOnTop: 'nope' },
      widgets: {
        good: { widget_id: 'w1', conversation_id: 'good', expanded: true, hidden: false, chat_location: 'widget' },
        bad: { widget_id: 'w2', conversation_id: '../bad', expanded: false, hidden: false, chat_location: 'main' },
        junk: 42,
      },
    });
    expect(state.settings).toMatchObject({ enabled: true, scale: 0.75, alwaysOnTop: true });
    expect(state.settings).not.toHaveProperty('legacyFlag');
    expect(Object.keys(state.widgets)).toEqual(['good']);
    expect(state.widgets.good.expanded).toBe(false);
    expect(normalizeWidgetState(undefined).settings.enabled).toBe(true);
  });
});
