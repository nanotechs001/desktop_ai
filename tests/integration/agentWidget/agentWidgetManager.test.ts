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
    webContents = { send: vi.fn(), setZoomMode: vi.fn(), setVisualZoomLevelLimits: vi.fn(() => Promise.resolve()) };
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
      // Like Electron: position and size arguments must be integers.
      if (!Number.isInteger(x) || !Number.isInteger(y)) throw new TypeError('conversion failure from setPosition');
      // Like Windows: moving onto a display with another scale factor rescales the window.
      const k = h.scaleAt(x) / h.scaleAt(this.bounds.x);
      this.bounds = { x, y, width: Math.round(this.bounds.width * k), height: Math.round(this.bounds.height * k) };
    }
    setBounds(b: Rect) {
      if (![b.x, b.y, b.width, b.height].every(Number.isInteger))
        throw new TypeError('conversion failure from setBounds');
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
    'setWindowMode',
    'adjustWindow',
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
    'watchInMain',
    'followInMain',
    'followActivity',
    'openPageInMain',
    'openFileInMain',
    'openPreviewInMain',
    'rendererReady',
    'animationDone',
    'setSuspended',
    'showConversation',
    'broadcastBotColors',
    'broadcastConfig',
    'broadcastAssistantsChanged',
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
    'configChanged',
    'assistantsChanged',
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
    manager.ensure(A);
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

  it('ignores a conversation that has no live robot', async () => {
    const { manager } = await makeManager();
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);
    manager.openLinkInMain('unknown-conv', URL_IN_CHAT);
    expect(main.show).not.toHaveBeenCalled();
    expect(main.focus).not.toHaveBeenCalled();
    expect(main.webContents.send).not.toHaveBeenCalled();
  });

  it('the manager refuses a non-http(s) url too', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
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

describe('the main window follows the robot chat', () => {
  const makeMain = () => ({
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  });

  it('tells the main window, without focusing it, when a popup opens or moves to another chat', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, 'bot-1');
    appear(manager, A);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);

    manager.openPopup(A, 'bot-1');
    expect(main.webContents.send).toHaveBeenLastCalledWith('tray:follow-robot-chat', { conversation_id: A });

    manager.retarget(A, B); // the popup's new chat, or one picked from the bot's history
    expect(main.webContents.send).toHaveBeenLastCalledWith('tray:follow-robot-chat', { conversation_id: B });
    expect(main.focus).not.toHaveBeenCalled();
    expect(main.show).not.toHaveBeenCalled();
  });

  it('says nothing when the user only clicks into an open popup (to minimize it, say)', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, 'bot-1');
    appear(manager, A);
    manager.openPopup(A, 'bot-1');
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);

    liveWindows()[0].emit('focus');

    expect(main.webContents.send).not.toHaveBeenCalled();
  });

  it('a press inside an open popup (compact or expanded) asks the main window to follow; a closed one does not', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    manager.ensure(A, false, 'bot-1');
    appear(manager, A);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);

    await h.providers.followInMain({ conversation_id: A });
    expect(main.webContents.send).not.toHaveBeenCalled();

    manager.openPopup(A, 'bot-1');
    main.webContents.send.mockClear();
    manager.setWindowMode(A, 'expanded');
    await h.providers.followInMain({ conversation_id: A });
    expect(main.webContents.send).toHaveBeenCalledWith('tray:follow-robot-chat', { conversation_id: A });
    expect(main.focus).not.toHaveBeenCalled();
    await expect(h.providers.followInMain({ conversation_id: '../x' })).rejects.toThrow();
  });

  it('says nothing when the popup closes', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, 'bot-1');
    appear(manager, A);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);
    manager.setExpanded(A, false);
    expect(main.webContents.send).not.toHaveBeenCalled();
  });
});

describe('AgentWidgetManager watchInMain', () => {
  const makeMain = () => ({
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  });

  it("brings the main window forward on the robot's conversation, with no link, and keeps the chat in its popup", async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.setChatLocation(A, 'widget');
    initAgentWidgetBridge(manager);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);

    await h.providers.watchInMain({ conversation_id: A });

    expect(main.focus).toHaveBeenCalled();
    expect(main.webContents.send).toHaveBeenCalledWith('tray:open-link-in-conversation', { conversation_id: A });
    expect(manager.getChatLocations()[A]).toBe('widget');
  });

  it('ignores a conversation without a live robot and rejects a malformed payload', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);

    manager.watchInMain('unknown-conv');
    await expect(h.providers.watchInMain({ conversation_id: '../x' })).rejects.toThrow();
    await expect(h.providers.watchInMain({ conversation_id: A, url: 'https://x.test/' })).rejects.toThrow();

    expect(main.show).not.toHaveBeenCalled();
    expect(main.webContents.send).not.toHaveBeenCalled();
  });
});

const between = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);

describe('expanded window mode', () => {
  // 1920x1040 work area, 88 px robot: band 78 (0.75 of the robot plus the hop headroom), panel 960x640, window
  // 960x718 centred.
  const BAND = 66 + HOP_HEADROOM;
  const EXPANDED = { x: 480, y: 161, width: 960, height: 718 };
  const START_OFFSET = 960 - BOT - 24;
  type WindowLayout = LayoutEvent & {
    expanded: boolean;
    window_mode: 'compact' | 'expanded';
    top_band: number;
    bot_offset_x: number;
    popup_vertical: 'above' | 'below';
  };
  const layoutOf = (id: string) => lastLayout(id) as WindowLayout | undefined;
  const offsetsOf = (id: string) =>
    (emittedOf('layoutChanged') as WindowLayout[])
      .filter((l) => l.conversation_id === id && l.top_band > 0)
      .map((l) => l.bot_offset_x);

  it('collapsed, only records the mode; the next popup opens as a large window centred, robot at top-right', async () => {
    const { manager, mem } = await makeManager();
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    const collapsed = { ...win.bounds };

    manager.setWindowMode(A, 'expanded');
    expect(win.bounds).toEqual(collapsed);
    expect(mem.get().widgets[A].window_mode).toBe('expanded');

    manager.setExpanded(A, true);
    expect(win.bounds).toEqual(EXPANDED);
    expect(layoutOf(A)).toMatchObject({
      expanded: true,
      window_mode: 'expanded',
      popup_vertical: 'below',
      bot_offset_x: START_OFFSET,
      top_band: BAND,
    });

    manager.setExpanded(A, false);
    vi.advanceTimersByTime(1_000); // dropped from the band onto the taskbar below it
    expect(win.bounds).toEqual({ ...collapsed, x: EXPANDED.x + START_OFFSET });
    expect(layoutOf(A)).toMatchObject({ top_band: 0, window_mode: 'expanded' });
  });

  it('insets the robot by its hop headroom; the band grows by as much, so the overlap with the panel is unchanged', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    appear(manager, A);
    manager.setWindowMode(A, 'expanded');
    manager.setExpanded(A, true);
    const layout = layoutOf(A)!;
    expect(layout.hop_headroom).toBe(HOP_HEADROOM);
    expect(layout.top_band - layout.hop_headroom).toBe(66);
    // The robot's bottom (headroom + size) overlaps the panel by a quarter of the robot.
    expect(layout.hop_headroom + BOT - layout.top_band).toBe(BOT - 66);
  });

  it('stays open when focus leaves the expanded window; the compact popup still collapses on blur', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    const clickOutside = () => {
      vi.advanceTimersByTime(1_000); // past the open grace period
      win.emit('focus');
      Object.assign(win, { focused: false });
      win.emit('blur');
      vi.advanceTimersByTime(1_000);
    };

    manager.setWindowMode(A, 'expanded');
    manager.setExpanded(A, true);
    clickOutside();
    expect(layoutOf(A)).toMatchObject({ expanded: true, window_mode: 'expanded' });
    expect(win.bounds).toEqual(EXPANDED);

    manager.setWindowMode(A, 'compact');
    clickOutside();
    expect(layoutOf(A)).toMatchObject({ expanded: false, window_mode: 'compact' });
  });

  it('expanding an open popup re-places at once; restoring returns to the compact popup above the robot', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    manager.setExpanded(A, true);
    const compact = { ...win.bounds };
    expect(layoutOf(A)).toMatchObject({ window_mode: 'compact', top_band: 0 });

    manager.setWindowMode(A, 'expanded');
    vi.advanceTimersByTime(300);
    expect(win.bounds).toEqual(EXPANDED);

    manager.setWindowMode(A, 'compact');
    vi.advanceTimersByTime(300);
    expect(win.bounds).toEqual(compact);
    expect(layoutOf(A)).toMatchObject({ expanded: true, window_mode: 'compact', top_band: 0, drag_phase: 'none' });
  });

  describe('switching modes smoothly', () => {
    async function openCompact(settings: Record<string, unknown> = {}) {
      const { manager } = await makeManager({ settings: { enabled: true, ...settings } });
      manager.ensure(A);
      const win = liveWindows()[0];
      appear(manager, A);
      manager.setExpanded(A, true);
      return { manager, win, compact: { ...win.bounds } };
    }
    const transitioning = () => (layoutOf(A) as { window_transitioning?: boolean } | undefined)?.window_transitioning;

    it('eases the window in and out to the expanded bounds over about 280 ms and ends exactly on them', async () => {
      const { manager, win, compact } = await openCompact();
      manager.setWindowMode(A, 'expanded');
      expect(win.bounds).toEqual(compact); // nothing snaps
      expect(transitioning()).toBe(true);
      const widths: number[] = [];
      for (let t = 0; t < 260; t += 16) {
        vi.advanceTimersByTime(16);
        widths.push(win.bounds.width);
      }
      const span = EXPANDED.width - compact.width;
      expect(between(widths[3], compact.width, EXPANDED.width)).toBe(true);
      expect(widths.slice(1).every((w, i) => w >= widths[i])).toBe(true);
      // Ease-in-out: no leap on the first steps (under a fifth of the way after a quarter of the time), and a gentle
      // stop (most of the way done by three quarters).
      expect(widths[3] - compact.width).toBeLessThan(span / 5);
      expect(widths[12] - compact.width).toBeGreaterThan(span * 0.8);
      vi.advanceTimersByTime(40);
      expect(win.bounds).toEqual(EXPANDED);
      expect(transitioning()).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(win.bounds).toEqual(EXPANDED);
    });

    it('restoring eases back to the compact popup, and the robot does not drop', async () => {
      const { manager, win, compact } = await openCompact();
      manager.setWindowMode(A, 'expanded');
      vi.advanceTimersByTime(300);
      manager.setWindowMode(A, 'compact');
      expect(win.bounds).toEqual(EXPANDED);
      vi.advanceTimersByTime(100);
      expect(between(win.bounds.width, compact.width, EXPANDED.width)).toBe(true);
      vi.advanceTimersByTime(200);
      expect(win.bounds).toEqual(compact);
      expect(lastDragPhase(A)).toBe('none');
    });

    it('snaps at once with reduce motion', async () => {
      const { manager, win } = await openCompact({ reduceMotion: true });
      manager.setWindowMode(A, 'expanded');
      expect(win.bounds).toEqual(EXPANDED);
      expect(transitioning()).toBe(false);
    });

    it('a second switch mid-way turns back from where the window is, with no jump and no leftover timer', async () => {
      const { manager, win, compact } = await openCompact();
      manager.setWindowMode(A, 'expanded');
      vi.advanceTimersByTime(96);
      const mid = { ...win.bounds };
      manager.setWindowMode(A, 'compact');
      expect(win.bounds).toEqual(mid);
      vi.advanceTimersByTime(64);
      expect(between(win.bounds.width, compact.width, mid.width)).toBe(true);
      vi.advanceTimersByTime(230);
      expect(win.bounds).toEqual(compact);
      vi.advanceTimersByTime(1_000);
      expect(win.bounds).toEqual(compact);
    });

    it('closing mid-way stops the transition: the window is the robot box and stays so', async () => {
      const { manager, win } = await openCompact();
      manager.setWindowMode(A, 'expanded');
      vi.advanceTimersByTime(48);
      manager.setExpanded(A, false);
      vi.advanceTimersByTime(1_000);
      expect(win.bounds.width).toBe(BOT);
      expect(win.bounds.y + win.bounds.height).toBe(1040);
      expect(transitioning()).toBe(false);
    });
  });

  it('keeps the mode across a restart and a retarget', async () => {
    const first = await makeManager();
    first.manager.ensure(A);
    first.manager.setWindowMode(A, 'expanded');
    first.manager.dispose();

    const second = await makeManager(first.mem.get());
    const win = liveWindows()[0];
    appear(second.manager, A);
    second.manager.setExpanded(A, true);
    expect(win.bounds).toEqual(EXPANDED);

    second.manager.retarget(A, B);
    expect(second.mem.get().widgets[B].window_mode).toBe('expanded');
    expect(second.manager.getSnapshot(B)?.layout).toMatchObject({ window_mode: 'expanded', top_band: BAND });
    expect(win.bounds).toEqual(EXPANDED);
  });

  it('several robots can be expanded at once', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.ensure(B);
    appear(manager, A);
    appear(manager, B);
    manager.setWindowMode(A, 'expanded');
    manager.setWindowMode(B, 'expanded');
    manager.setExpanded(A, true);
    manager.setExpanded(B, true);
    expect(manager.getSnapshot(A)?.layout.top_band).toBe(BAND);
    expect(manager.getSnapshot(B)?.layout.top_band).toBe(BAND);
  });

  /** An open, expanded robot; the cursor rests over it (hovering never stops walking in the band). */
  async function expandedWalker() {
    const manager = await wanderingManager(0.5); // strolls every 2.75 s, target = middle of the band
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    manager.setWindowMode(A, 'expanded');
    manager.setExpanded(A, true);
    h.cursor = { x: EXPANDED.x + START_OFFSET + 10, y: EXPANDED.y + 10 };
    return { manager, win };
  }

  it('walks along the top band while idle, at 2 px per 50 ms, facing its way, without moving the window', async () => {
    const { win } = await expandedWalker();
    vi.advanceTimersByTime(3_000 + 300); // first stroll after one stroll delay, then a turn pause
    expect(layoutOf(A)).toMatchObject({ moving: true, facing: 'left' });
    const x0 = layoutOf(A)!.bot_offset_x;
    vi.advanceTimersByTime(500);
    expect(x0 - layoutOf(A)!.bot_offset_x).toBe(20);
    vi.advanceTimersByTime(60_000);
    expect(layoutOf(A)).toMatchObject({ moving: false, bot_offset_x: 16 + Math.round(0.5 * (960 - BOT - 32)) });
    for (const x of offsetsOf(A)) {
      expect(x).toBeGreaterThanOrEqual(16);
      expect(x).toBeLessThanOrEqual(960 - BOT - 16);
    }
    expect(win.bounds).toEqual(EXPANDED);
  });

  it('does not walk when not idle or with reduce motion', async () => {
    const { manager } = await expandedWalker();
    manager.reportState(A, 'working');
    vi.advanceTimersByTime(60_000);
    expect(layoutOf(A)).toMatchObject({ moving: false, bot_offset_x: START_OFFSET });

    manager.setSettings({ reduceMotion: true });
    manager.reportState(A, 'idle');
    vi.advanceTimersByTime(60_000);
    expect(layoutOf(A)).toMatchObject({ moving: false, bot_offset_x: START_OFFSET });
  });

  it('collapsing mid-walk stops it, and the robot drops from where it stood in the band', async () => {
    const { manager, win } = await expandedWalker();
    vi.advanceTimersByTime(3_000 + 600);
    expect(layoutOf(A)?.moving).toBe(true);
    const x = EXPANDED.x + layoutOf(A)!.bot_offset_x;
    manager.setExpanded(A, false);
    expect(layoutOf(A)?.moving).toBe(false);
    expect(win.bounds.x).toBe(x);
    vi.advanceTimersByTime(1_000);
    expect(win.bounds.x).toBe(x);
    expect(win.bounds.y + win.bounds.height).toBe(1040);
  });

  it('drags and resizes the expanded window by fractional pointer deltas, and the robot stops its drag pose', async () => {
    h.displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1511, height: 945 }, workArea: { x: 0, y: 25, width: 1511, height: 883 } },
    ];
    const { manager } = await makeManager();
    manager.ensure(A);
    const win = liveWindows().at(-1)!;
    appear(manager, A);
    manager.setWindowMode(A, 'expanded');
    manager.setExpanded(A, true);
    const before = { ...win.bounds };

    manager.adjustWindow(A, 'move', 'start', 0, 0);
    expect(lastDragPhase(A)).toBe('dragging');
    // Chromium reports pointer screen coordinates with fractions.
    manager.adjustWindow(A, 'move', 'move', -100.6, 37.25);
    manager.adjustWindow(A, 'move', 'end', -100.6, 37.25);

    expect(win.bounds.x).toBe(before.x - 101);
    expect(win.bounds.y).toBe(before.y + 37);
    expect(lastDragPhase(A)).toBe('none');

    manager.adjustWindow(A, 'e', 'start', 0, 0);
    manager.adjustWindow(A, 'e', 'end', -40.4, 0);
    expect(win.bounds.width).toBe(before.width - 40);
  });

  it('a remembered expanded window saved with fractions still drags, restores and re-expands', async () => {
    const { manager } = await makeManager({
      settings: { enabled: true },
      widgets: {
        [A]: {
          widget_id: 'w-a',
          conversation_id: A,
          expanded: false,
          hidden: false,
          chat_location: 'main',
          x_ratio: 0.5,
          window_mode: 'expanded',
          expanded_bounds: { x: 889.921875, y: 307.109375, width: 1200, height: 725 },
        },
      },
    });
    const win = liveWindows().at(-1)!;
    appear(manager, A);
    manager.setExpanded(A, true);
    expect(win.bounds).toEqual({ x: 890, y: 307, width: 1200, height: 725 });

    manager.adjustWindow(A, 'move', 'start', 0, 0);
    manager.adjustWindow(A, 'move', 'end', 30, 20);
    expect(win.bounds).toMatchObject({ x: 920, y: 327 });
    expect(lastDragPhase(A)).toBe('none');

    manager.setWindowMode(A, 'compact');
    vi.advanceTimersByTime(1_000);
    manager.setWindowMode(A, 'expanded');
    vi.advanceTimersByTime(1_000);
    expect(win.bounds).toEqual({ x: 920, y: 327, width: 1200, height: 725 });
  });

  describe('closing drops the robot where it stands', () => {
    const BAND_LEFT = EXPANDED.x + START_OFFSET;
    const BAND_TOP = EXPANDED.y + HOP_HEADROOM;
    async function openExpanded(initial: unknown = { settings: { enabled: true } }) {
      const made = await makeManager(initial);
      made.manager.ensure(A);
      const win = liveWindows().at(-1)!; // after any restored robot
      appear(made.manager, A);
      made.manager.setWindowMode(A, 'expanded');
      made.manager.setExpanded(A, true);
      return { ...made, win };
    }

    it('× drops it straight down from its band spot onto the taskbar, landing like a released drag', async () => {
      const { manager, mem, win } = await openExpanded();
      manager.setChatLocation(A, 'main');
      expect(win.bounds.x).toBe(BAND_LEFT);
      expect(robotTop(win)).toBe(BAND_TOP);
      expect(lastDragPhase(A)).toBe('landing');
      expect(mem.get().widgets[A].x_ratio).toBeCloseTo(BAND_LEFT / (1920 - BOT), 3);

      const tops: number[] = [];
      for (let t = 0; t < 700; t += 16) {
        vi.advanceTimersByTime(16);
        tops.push(robotTop(win));
        expect(win.bounds.x).toBe(BAND_LEFT); // straight down
      }
      expect(tops.slice(1).every((top, i) => top >= tops[i])).toBe(true);
      expect(tops[Math.ceil(360 / 16)]).toBe(TRACK_Y);
      vi.advanceTimersByTime(100);
      expect(lastDragPhase(A)).toBe('none');
      expect(win.bounds.y + win.bounds.height).toBe(1040);
    });

    it('Escape drops it too, from wherever the window was moved', async () => {
      const { manager, win } = await openExpanded();
      manager.adjustWindow(A, 'move', 'start', 0, 0);
      manager.adjustWindow(A, 'move', 'end', -300, -100);
      manager.setExpanded(A, false);
      expect(win.bounds.x).toBe(BAND_LEFT - 300);
      expect(robotTop(win)).toBe(BAND_TOP - 100);
      vi.advanceTimersByTime(1_000);
      expect(win.bounds.x).toBe(BAND_LEFT - 300);
      expect(robotTop(win)).toBe(TRACK_Y);
    });

    it('lands beside a robot already standing there, like a drag drop', async () => {
      const ratio = BAND_LEFT / (1920 - BOT);
      const { manager, win } = await openExpanded({
        settings: { enabled: true },
        widgets: {
          [B]: {
            widget_id: 'w-b',
            conversation_id: B,
            expanded: false,
            hidden: false,
            chat_location: 'main',
            x_ratio: ratio,
          },
        },
      });
      const winB = liveWindows().find((w) => w !== win)!;
      expect(winB.bounds.x).toBe(BAND_LEFT);
      manager.setExpanded(A, false);
      vi.advanceTimersByTime(1_000);
      expect(Math.abs(win.bounds.x - winB.bounds.x)).toBeGreaterThanOrEqual(Math.round(BOT * 1.25));
    });

    it('with reduce motion it lands at once at that x', async () => {
      const { manager, win } = await openExpanded({ settings: { enabled: true, reduceMotion: true } });
      manager.setChatLocation(A, 'main');
      expect(lastDragPhase(A)).toBe('none');
      expect(win.bounds.x).toBe(BAND_LEFT);
      expect(robotTop(win)).toBe(TRACK_Y);
    });

    it('closing the compact popup leaves the robot where it stands on the taskbar', async () => {
      const { manager } = await makeManager();
      manager.ensure(A);
      const win = liveWindows()[0];
      appear(manager, A);
      const before = { ...win.bounds };
      manager.setExpanded(A, true);
      manager.setChatLocation(A, 'main');
      expect(win.bounds).toEqual(before);
      expect(lastDragPhase(A) ?? 'none').toBe('none');
    });
  });

  it('snaps the robot back into the band after a re-place', async () => {
    const { manager } = await expandedWalker();
    manager.setSettings({ scale: 1.5 }); // 132 px robot: the band's right end moves left of the robot
    expect(layoutOf(A)?.bot_offset_x).toBe(960 - 132 - 16);
  });

  it('a band walk stops when the chat goes back to the main window (×)', async () => {
    const { manager, win } = await expandedWalker();
    vi.advanceTimersByTime(3_000 + 600);
    expect(layoutOf(A)?.moving).toBe(true);
    manager.setChatLocation(A, 'main');
    expect(layoutOf(A)).toMatchObject({ expanded: false, moving: false, top_band: 0 });
    vi.advanceTimersByTime(1_000); // any landing is over
    const x = win.bounds.x;
    h.cursor = { x: x + BOT / 2, y: 500 }; // the mouse is over the robot: it has no reason to follow it
    vi.advanceTimersByTime(10_000);
    expect(win.bounds.x).toBe(x);
    expect(win.bounds.y + win.bounds.height).toBe(1040);
  });

  it('a re-place (display or scale change) ends a walk instead of leaving it running', async () => {
    await expandedWalker();
    vi.advanceTimersByTime(3_000 + 600);
    expect(layoutOf(A)?.moving).toBe(true);
    for (const fn of h.screenListeners['display-metrics-changed'] ?? []) fn();
    expect(layoutOf(A)?.moving).toBe(false);
  });

  it('a Recent pick keeps the expanded window open, unresized, with the robot where it stood', async () => {
    const { manager, win } = await expandedWalker();
    vi.advanceTimersByTime(3_000 + 600 + 500); // walked a bit
    const offset = layoutOf(A)!.bot_offset_x;
    const setBounds = vi.spyOn(win as unknown as { setBounds: (b: Rect) => void }, 'setBounds');
    manager.retarget(A, B);
    expect(setBounds).not.toHaveBeenCalled();
    expect(win.bounds).toEqual(EXPANDED);
    expect(layoutOf(B)).toMatchObject({ expanded: true, top_band: BAND, bot_offset_x: offset });
    expect(manager.getChatLocations()).toEqual({ [B]: 'widget' });
    expect(emittedOf('chatLocationChanged')).toContainEqual({ conversation_id: A, location: 'main' });
  });

  it('dragging the robot out of the band picks it up where it stands, keeping the grab offset', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    const win = liveWindows()[0];
    appear(manager, A);
    manager.setWindowMode(A, 'expanded');
    manager.setExpanded(A, true);
    vi.advanceTimersByTime(300);
    const botLeft = EXPANDED.x + START_OFFSET;
    const botTop = EXPANDED.y + HOP_HEADROOM;
    h.cursor = { x: botLeft + 40, y: botTop + 30 };
    manager.dragStart(A);
    expect(win.bounds.x).toBe(botLeft);
    expect(robotTop(win)).toBe(botTop);
    h.cursor = { x: botLeft + 140, y: botTop + 80 };
    manager.dragMove(A);
    expect(win.bounds.x).toBe(botLeft + 100);
    expect(robotTop(win)).toBe(botTop + 50);
  });

  it('a second expanded window on the same display opens cascaded, not on top of the first', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    manager.ensure(B);
    appear(manager, A);
    appear(manager, B);
    const [winA, winB] = liveWindows();
    manager.setWindowMode(A, 'expanded');
    manager.setWindowMode(B, 'expanded');
    manager.setExpanded(A, true);
    manager.setExpanded(B, true);
    expect(winA.bounds).toEqual(EXPANDED);
    expect(winB.bounds).toEqual({ ...EXPANDED, x: EXPANDED.x + 28, y: EXPANDED.y + 28 });
  });

  describe('moving and resizing the expanded window', () => {
    // The band (78) plus the title bar (56) stay on screen; at least 160 px of the window stay in view sideways.
    const REACH = BAND + 56;
    async function openExpanded() {
      const made = await makeManager();
      made.manager.ensure(A);
      const win = liveWindows()[0];
      appear(made.manager, A);
      made.manager.setWindowMode(A, 'expanded');
      made.manager.setExpanded(A, true);
      return { ...made, win };
    }
    const gesture =
      (manager: AgentWidgetManager, kind: string) =>
      (phase: 'start' | 'move' | 'end', dx = 0, dy = 0) =>
        manager.adjustWindow(A, kind as never, phase, dx, dy);

    it('dragging the title bar moves the whole window, keeping the title bar reachable', async () => {
      const { manager, win } = await openExpanded();
      const move = gesture(manager, 'move');
      move('start');
      move('move', 100, 50);
      expect(win.bounds).toEqual({ ...EXPANDED, x: EXPANDED.x + 100, y: EXPANDED.y + 50 });
      move('move', -5_000, -5_000);
      expect(win.bounds).toEqual({ ...EXPANDED, x: 160 - EXPANDED.width, y: 0 });
      move('move', 5_000, 5_000);
      expect(win.bounds).toEqual({ ...EXPANDED, x: 1920 - 160, y: 1040 - REACH });
      move('end', 5_000, 5_000);
      expect(win.bounds).toEqual({ ...EXPANDED, x: 1920 - 160, y: 1040 - REACH });
    });

    it('may cross onto another monitor', async () => {
      h.displays = [
        structuredClone(BOTTOM_TASKBAR),
        {
          id: 2,
          bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
          workArea: { x: 1920, y: 0, width: 1920, height: 1040 },
        },
      ];
      const { manager, win } = await openExpanded();
      const move = gesture(manager, 'move');
      move('start');
      move('move', 1_700, 0);
      expect(win.bounds.x).toBe(EXPANDED.x + 1_700);
    });

    it('the robot keeps its band spot and plays its carry animation through a window drag, then walks again', async () => {
      const { manager } = await expandedWalker();
      const move = gesture(manager, 'move');
      move('start');
      expect(layoutOf(A)).toMatchObject({ drag_phase: 'dragging', moving: false, bot_offset_x: START_OFFSET });
      for (let i = 0; i < 20; i++) {
        move('move', i * 5, i * 3);
        vi.advanceTimersByTime(1_000);
      }
      expect(offsetsOf(A).every((x) => x === START_OFFSET)).toBe(true);
      expect(layoutOf(A)).toMatchObject({ drag_phase: 'dragging', moving: false });
      move('end', 100, 60);
      expect(layoutOf(A)).toMatchObject({ drag_phase: 'none', bot_offset_x: START_OFFSET });
      vi.advanceTimersByTime(3_000 + 600);
      expect(layoutOf(A)?.moving).toBe(true);
    });

    it('a drag whose release never arrives ends by itself', async () => {
      const { manager } = await openExpanded();
      const move = gesture(manager, 'move');
      move('start');
      move('move', 10, 10);
      vi.advanceTimersByTime(8_000 + 100);
      expect(layoutOf(A)?.drag_phase).toBe('none');
    });

    it('resizing keeps the panel at least 640x440 and the window inside the work area; the robot keeps its place from the right', async () => {
      const { manager, win } = await openExpanded();
      const fromRight = EXPANDED.width - START_OFFSET;
      const west = gesture(manager, 'w');
      west('start');
      west('move', -10_000, 0);
      expect(win.bounds).toEqual({ ...EXPANDED, x: 0, width: EXPANDED.x + EXPANDED.width });
      expect(layoutOf(A)?.bot_offset_x).toBe(EXPANDED.x + EXPANDED.width - fromRight);
      west('end', -10_000, 0);

      const east = gesture(manager, 'e');
      east('start');
      east('end', 10_000, 0);
      expect(win.bounds).toMatchObject({ x: 0, width: 1920 });

      const corner = gesture(manager, 'se');
      corner('start');
      corner('move', -10_000, -10_000);
      expect(win.bounds).toEqual({ x: 0, y: EXPANDED.y, width: 640, height: BAND + 440 });
      expect(layoutOf(A)?.bot_offset_x).toBe(640 - fromRight);
      corner('end', -10_000, -10_000);

      const north = gesture(manager, 'n');
      north('start');
      north('end', 0, -10_000);
      expect(win.bounds).toMatchObject({ y: 0, height: EXPANDED.y + BAND + 440 });
    });

    it('on Windows a resize never hides and re-shows the window on each frame', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        const { manager, win } = await openExpanded();
        win.visible = true;
        const hide = vi.spyOn(win as unknown as { hide: () => void }, 'hide');
        const east = gesture(manager, 'e');
        east('start');
        for (let i = 1; i <= 5; i++) east('move', -i * 10, 0);
        east('end', -50, 0);
        expect(win.bounds.width).toBe(EXPANDED.width - 50);
        expect(hide).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    });

    it('the robot walks within the new width after a resize', async () => {
      const { manager } = await expandedWalker();
      const corner = gesture(manager, 'sw');
      corner('start');
      corner('end', 320, -10_000); // 640 wide
      vi.advanceTimersByTime(60_000);
      for (const x of offsetsOf(A)) expect(x).toBeLessThanOrEqual(960 - BOT - 16);
      expect(layoutOf(A)!.bot_offset_x).toBeLessThanOrEqual(640 - BOT - 16);
    });

    it('remembers the bounds per robot once a drag ends, saves them shortly after, and reuses them on the next expand', async () => {
      const { manager, mem, win } = await openExpanded();
      const move = gesture(manager, 'move');
      move('start');
      move('move', 100, 50);
      vi.advanceTimersByTime(2_000);
      expect(mem.get().widgets[A].expanded_bounds).toBeUndefined(); // not on every frame
      move('end', 100, 50);
      const moved = { ...EXPANDED, x: EXPANDED.x + 100, y: EXPANDED.y + 50 };
      vi.advanceTimersByTime(1_000);
      expect(mem.get().widgets[A].expanded_bounds).toEqual(moved);

      manager.setExpanded(A, false);
      vi.advanceTimersByTime(1_000);
      manager.setExpanded(A, true);
      expect(win.bounds).toEqual(moved);

      manager.setWindowMode(A, 'compact');
      vi.advanceTimersByTime(300);
      manager.setWindowMode(A, 'expanded');
      vi.advanceTimersByTime(300);
      expect(win.bounds).toEqual(moved);

      manager.retarget(A, B);
      expect(win.bounds).toEqual(moved);
      expect(mem.get().widgets[B].expanded_bounds).toEqual(moved);
    });

    it('opens centred again when the remembered bounds no longer fit on any display', async () => {
      const first = await makeManager();
      first.manager.ensure(A);
      first.manager.setWindowMode(A, 'expanded');
      first.manager.dispose();
      const saved = first.mem.get();
      saved.widgets[A].expanded_bounds = { x: 5_000, y: 100, width: 960, height: 718 };

      const second = await makeManager(saved);
      const win = liveWindows()[0];
      appear(second.manager, A);
      second.manager.setExpanded(A, true);
      expect(win.bounds).toEqual(EXPANDED);
    });

    it('rejects a malformed adjustWindow at the IPC boundary', async () => {
      const { manager, win } = await openExpanded();
      initAgentWidgetBridge(manager);
      const ok = { conversation_id: A, gesture: 'move', phase: 'start', dx: 0, dy: 0 };
      await expect(h.providers.adjustWindow({ ...ok, dx: Number.NaN })).rejects.toThrow();
      await expect(h.providers.adjustWindow({ ...ok, dy: Number.POSITIVE_INFINITY })).rejects.toThrow();
      await expect(h.providers.adjustWindow({ ...ok, dx: '10' })).rejects.toThrow();
      await expect(h.providers.adjustWindow({ ...ok, gesture: 'spin' })).rejects.toThrow();
      await expect(h.providers.adjustWindow({ ...ok, phase: 'later' })).rejects.toThrow();
      await expect(h.providers.adjustWindow({ ...ok, extra: 1 })).rejects.toThrow();
      await expect(h.providers.adjustWindow({ conversation_id: A, gesture: 'move', phase: 'start' })).rejects.toThrow();
      expect(win.bounds).toEqual(EXPANDED);
      await expect(h.providers.adjustWindow(ok)).resolves.toBeUndefined();
      await expect(h.providers.adjustWindow({ ...ok, phase: 'move', dx: 10, dy: 0 })).resolves.toBeUndefined();
      expect(win.bounds.x).toBe(EXPANDED.x + 10);
    });

    it('ignores window gestures outside the expanded window', async () => {
      const { manager } = await makeManager();
      manager.ensure(A);
      const win = liveWindows()[0];
      appear(manager, A);
      const before = { ...win.bounds };
      const move = gesture(manager, 'move');
      move('start');
      move('move', 100, 100);
      expect(win.bounds).toEqual(before);
    });
  });

  it('rejects a malformed setWindowMode at the IPC boundary', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    manager.ensure(A);
    await expect(h.providers.setWindowMode({ conversation_id: A, mode: 'huge' })).rejects.toThrow();
    await expect(h.providers.setWindowMode({ conversation_id: A })).rejects.toThrow();
    await expect(h.providers.setWindowMode({ conversation_id: A, mode: 'expanded', x: 1 })).rejects.toThrow();
    await expect(h.providers.setWindowMode({ conversation_id: '../x', mode: 'expanded' })).rejects.toThrow();
    await expect(h.providers.setWindowMode({ conversation_id: A, mode: 'expanded' })).resolves.toBeUndefined();
    expect(manager.getSnapshot(A)?.record.window_mode).toBe('expanded');
  });
});

describe('robot windows in combination with the main window', () => {
  const BOT_ID = 'bot-1';
  const makeMain = () => ({
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  });
  const followsOf = (main: ReturnType<typeof makeMain>) =>
    main.webContents.send.mock.calls.filter(([channel]) => channel === 'tray:follow-robot-chat').map(([, d]) => d);

  it('hands an unsent popup draft to the main window when the robot moves to another chat', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, BOT_ID);
    appear(manager, A);
    manager.setExpanded(A, true);
    manager.retarget(A, B); // a Recent pick: the popup's window learns its chat went back to main, then hands it over
    manager.handoffDraft(A, 'half-typed');
    expect(emittedOf('draftReady')).toContainEqual({ conversation_id: A, to: 'main' });
    expect(manager.takeDraft(A)).toBe('half-typed');
  });

  it('a new chat started in the main window does not move into the open popup', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, BOT_ID);
    appear(manager, A);
    manager.setExpanded(A, true);
    manager.ensure(B, false, BOT_ID);
    expect(manager.getSnapshot(B)?.layout.expanded).toBe(false);
    expect(manager.getChatLocations()).toEqual({});
    expect(emittedOf('chatLocationChanged')).toContainEqual({ conversation_id: A, location: 'main' });
    expect(emittedOf('chatLocationChanged')).not.toContainEqual({ conversation_id: B, location: 'widget' });
  });

  it('agent activity is followed only for the open popup the user last opened or pressed in', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    manager.ensure(A, false, BOT_ID);
    manager.ensure(C, false, 'bot-2');
    appear(manager, A);
    appear(manager, C);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);

    await h.providers.followActivity({ conversation_id: A });
    expect(followsOf(main)).toEqual([]); // collapsed: never

    manager.openPopup(A, BOT_ID);
    manager.openPopup(C, 'bot-2');
    main.webContents.send.mockClear();
    await h.providers.followActivity({ conversation_id: A });
    expect(followsOf(main)).toEqual([]); // C was opened last
    await h.providers.followActivity({ conversation_id: C });
    expect(followsOf(main)).toEqual([{ conversation_id: C }]);

    await h.providers.followInMain({ conversation_id: A }); // the user pressed in A's popup
    main.webContents.send.mockClear();
    await h.providers.followActivity({ conversation_id: C });
    await h.providers.followActivity({ conversation_id: A });
    expect(followsOf(main)).toEqual([{ conversation_id: A }]);

    manager.setExpanded(A, false);
    main.webContents.send.mockClear();
    await h.providers.followActivity({ conversation_id: A });
    expect(followsOf(main)).toEqual([]);
    await expect(h.providers.followActivity({ conversation_id: '../x' })).rejects.toThrow();
  });

  it('the robot the user works with follows it to another chat', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, BOT_ID);
    appear(manager, A);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);
    manager.openPopup(A, BOT_ID);
    manager.retarget(A, B);
    main.webContents.send.mockClear();
    manager.followAgentActivity(B);
    expect(followsOf(main)).toEqual([{ conversation_id: B }]);
  });

  it('turning the robots off gives every chat back to the main window', async () => {
    const { manager, mem } = await makeManager();
    manager.ensure(A, false, BOT_ID);
    appear(manager, A);
    manager.setExpanded(A, true);
    manager.setSettings({ enabled: false });
    expect(emittedOf('chatLocationChanged').at(-1)).toEqual({ conversation_id: A, location: 'main' });
    expect(mem.get().widgets[A].chat_location).toBe('main');
  });

  it('a popup opened on a chat saved as in its robot still tells the windows (no two send boxes)', async () => {
    const { manager } = await makeManager({
      settings: { enabled: true },
      widgets: {
        [A]: { widget_id: 'w-a', conversation_id: A, expanded: false, hidden: false, chat_location: 'widget' },
      },
    });
    appear(manager, A);
    h.emitted.length = 0;
    manager.openPopup(A);
    expect(emittedOf('chatLocationChanged')).toContainEqual({ conversation_id: A, location: 'widget' });
  });

  it('removing a robot whose chat was in it gives the chat back to the main window', async () => {
    const { manager } = await makeManager();
    manager.ensure(A, false, BOT_ID);
    appear(manager, A);
    manager.setExpanded(A, true);
    manager.remove(A);
    expect(emittedOf('chatLocationChanged').at(-1)).toEqual({ conversation_id: A, location: 'main' });
  });

  it("relays one window's stored settings and Agent changes to every window, and validates them", async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    const news = { origin: 'robot-1', entries: { 'agent.enginePins': { bot: 'codex' }, 'agent.colors': null } };
    await h.providers.broadcastConfig(news);
    await h.providers.broadcastAssistantsChanged({ origin: 'robot-1' });
    expect(emittedOf('configChanged')).toEqual([news]);
    expect(emittedOf('assistantsChanged')).toEqual([{ origin: 'robot-1' }]);
    await expect(h.providers.broadcastConfig({ origin: '', entries: {} })).rejects.toThrow();
    await expect(h.providers.broadcastConfig({ origin: 'x', entries: {}, extra: 1 })).rejects.toThrow();
    await expect(h.providers.broadcastAssistantsChanged({})).rejects.toThrow();
  });

  it('locks the robot window zoom, so a main-window zoom never clips the robot', async () => {
    const { manager } = await makeManager();
    manager.ensure(A);
    const win = liveWindows()[0] as unknown as { webContents: { setZoomMode: ReturnType<typeof vi.fn> } };
    expect(win.webContents.setZoomMode).toHaveBeenCalledWith('disabled');
  });

  it('opens a page, a file or a preview of a live robot chat in the main window, and validates the request', async () => {
    const { manager } = await makeManager();
    initAgentWidgetBridge(manager);
    manager.ensure(A);
    const main = makeMain();
    host.getMainWindow.mockReturnValue(main);

    await h.providers.openPageInMain({ conversation_id: A, path: '/settings/agent' });
    expect(main.webContents.send).toHaveBeenLastCalledWith('tray:navigate-to-page', { path: '/settings/agent' });
    await h.providers.openPageInMain({ conversation_id: A, path: '/scheduled/cron_1' });
    expect(main.webContents.send).toHaveBeenLastCalledWith('tray:navigate-to-page', { path: '/scheduled/cron_1' });
    await expect(h.providers.openPageInMain({ conversation_id: A, path: '/settings/../x' })).rejects.toThrow();
    await expect(h.providers.openPageInMain({ conversation_id: A, path: 'https://example.com' })).rejects.toThrow();

    await h.providers.openFileInMain({ conversation_id: A, path: '/work/report.md' });
    expect(main.webContents.send).toHaveBeenLastCalledWith('tray:open-file-in-conversation', {
      conversation_id: A,
      path: '/work/report.md',
    });
    await expect(h.providers.openFileInMain({ conversation_id: A, path: '' })).rejects.toThrow();
    await expect(h.providers.openFileInMain({ conversation_id: A, path: 'x'.repeat(5000) })).rejects.toThrow();

    const diagram = { content: '```mermaid\ngraph TD\n```', content_type: 'markdown', title: 'Diagram' };
    await h.providers.openPreviewInMain({ conversation_id: A, ...diagram });
    expect(main.webContents.send).toHaveBeenLastCalledWith('tray:open-preview-in-conversation', {
      conversation_id: A,
      ...diagram,
      file_name: undefined,
      language: undefined,
    });
    await expect(
      h.providers.openPreviewInMain({ conversation_id: A, content: '<x>', content_type: 'browser' })
    ).rejects.toThrow();
    await expect(
      h.providers.openPreviewInMain({ conversation_id: A, ...diagram, content: 'x'.repeat(2_000_001) })
    ).rejects.toThrow();
    await expect(h.providers.openPreviewInMain({ conversation_id: A, ...diagram, editable: true })).rejects.toThrow();

    main.webContents.send.mockClear();
    await h.providers.openPageInMain({ conversation_id: B, path: '/settings/agent' }); // no robot: ignored
    await h.providers.openFileInMain({ conversation_id: B, path: '/work/report.md' });
    await h.providers.openPreviewInMain({ conversation_id: B, ...diagram });
    expect(main.webContents.send).not.toHaveBeenCalled();
  });
});
