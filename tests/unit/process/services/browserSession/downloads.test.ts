/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadItem } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  unlink: vi.fn(() => Promise.resolve()),
  existsSync: vi.fn(() => false),
  openPath: vi.fn(() => Promise.resolve('')),
  showItemInFolder: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/dl' },
  shell: { openPath: mocks.openPath, showItemInFolder: mocks.showItemInFolder },
}));
vi.mock('fs', () => ({ existsSync: mocks.existsSync, promises: { unlink: mocks.unlink } }));
vi.mock('@/common', () => ({ ipcBridge: { browser: { downloadsChanged: { emit: mocks.emit } } } }));

import {
  cancelDownload,
  getDownloads,
  handleWillDownload,
  openDownload,
  reduceDownloads,
  sanitizeFilename,
  showDownloadInFolder,
  uniqueDownloadPath,
} from '@process/services/browserSession/downloads';

const makeItem = (id: string, patch: Partial<DownloadItem> = {}): DownloadItem => ({
  id,
  url: `https://a.test/${id}`,
  filename: `${id}.bin`,
  savePath: `/dl/${id}.bin`,
  state: 'progressing',
  receivedBytes: 0,
  totalBytes: 100,
  ...patch,
});

/** A stand-in for Electron's DownloadItem: an emitter with the getters the handler reads. */
const makeElectronItem = (filename: string) => {
  const item = Object.assign(new EventEmitter(), {
    getFilename: () => filename,
    getURL: () => `https://a.test/${filename}`,
    getReceivedBytes: () => 10,
    getTotalBytes: () => 100,
    getSavePath: () => item.savePath,
    savePath: '',
    setSavePath: vi.fn((p: string) => {
      item.savePath = p;
    }),
    cancel: vi.fn(),
  });
  return item;
};

type ElectronItemArg = Parameters<typeof handleWillDownload>[0];
const start = (filename: string) => {
  const item = makeElectronItem(filename);
  handleWillDownload(item as unknown as ElectronItemArg);
  return item;
};

const lastEmitted = (): DownloadItem[] => (mocks.emit.mock.calls.at(-1) ?? [[]])[0] as DownloadItem[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existsSync.mockReturnValue(false);
  vi.useRealTimers();
});

const existsReadmeAndEnv = (p: string) => p === '/dl/README' || p === '/dl/.env';

describe('uniqueDownloadPath', () => {
  it('returns dir/file.pdf, then dir/file (1).pdf, then dir/file (2).pdf', () => {
    const taken = new Set<string>();
    const exists = (p: string) => taken.has(p);
    const first = uniqueDownloadPath('/dl', 'file.pdf', exists);
    taken.add(first);
    const second = uniqueDownloadPath('/dl', 'file.pdf', exists);
    taken.add(second);
    const third = uniqueDownloadPath('/dl', 'file.pdf', exists);
    expect([first, second, third]).toEqual(['/dl/file.pdf', '/dl/file (1).pdf', '/dl/file (2).pdf']);
  });

  it('handles names without extension and dotfiles', () => {
    expect(uniqueDownloadPath('/dl', 'README', existsReadmeAndEnv)).toBe('/dl/README (1)');
    expect(uniqueDownloadPath('/dl', '.env', existsReadmeAndEnv)).toBe('/dl/.env (1)');
  });
});

const existsTarGz = (p: string) => p === '/dl/file.tar.gz';

describe('uniqueDownloadPath with compound extensions', () => {
  it('keeps .tar.gz together: file.tar.gz -> file (1).tar.gz', () => {
    expect(uniqueDownloadPath('/dl', 'file.tar.gz', existsTarGz)).toBe('/dl/file (1).tar.gz');
    expect(uniqueDownloadPath('/dl', 'a.TAR.XZ', (p) => p === '/dl/a.TAR.XZ')).toBe('/dl/a (1).TAR.XZ');
  });
});

describe('sanitizeFilename', () => {
  it('strips "../", "/", "\\\\" and control characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFilename('a\\b/c.txt')).toBe('abc.txt');
    expect(sanitizeFilename('a\u0000b\u001fc\u007f.txt')).toBe('abc.txt');
  });

  it('strips Windows-illegal characters and trailing dots and spaces', () => {
    expect(sanitizeFilename('a:b.txt')).toBe('ab.txt');
    expect(sanitizeFilename('a<b>"c"|d?*.txt')).toBe('abcd.txt');
    expect(sanitizeFilename('name. . ')).toBe('name');
  });

  it('prefixes Windows reserved device names', () => {
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFilename('nul')).toBe('_nul');
    expect(sanitizeFilename('Com1.tar.gz')).toBe('_Com1.tar.gz');
    expect(sanitizeFilename('console.txt')).toBe('console.txt');
  });

  it('caps a name at 200 UTF-8 bytes and keeps the extension', () => {
    const long = sanitizeFilename(`${'a'.repeat(296)}.pdf`);
    expect(Buffer.byteLength(long)).toBe(200);
    expect(long.endsWith('.pdf')).toBe(true);
    const multibyte = sanitizeFilename(`${'é'.repeat(150)}.pdf`);
    expect(Buffer.byteLength(multibyte)).toBeLessThanOrEqual(200);
    expect(multibyte.endsWith('.pdf')).toBe(true);
    expect(multibyte).not.toContain('\uFFFD');
  });

  it('returns "download" when nothing is left', () => {
    expect(sanitizeFilename('.\u0000.')).toBe('download');
    expect(sanitizeFilename('')).toBe('download');
    expect(sanitizeFilename('../')).toBe('download');
    expect(sanitizeFilename('\u0000')).toBe('download');
  });
});

describe('reduceDownloads', () => {
  it('adds started and updates by id without mutating the input', () => {
    const a = makeItem('a');
    const initial = [a];
    const frozen = Object.freeze([...initial]);
    const withB = reduceDownloads(frozen as DownloadItem[], { type: 'started', item: makeItem('b') });
    expect(withB.map((i) => i.id)).toEqual(['a', 'b']);
    const updated = reduceDownloads(withB, { type: 'updated', item: makeItem('a', { receivedBytes: 50 }) });
    expect(updated[0].receivedBytes).toBe(50);
    expect(withB[0].receivedBytes).toBe(0);
    expect(updated).not.toBe(withB);
  });

  it('keeps the 50 newest', () => {
    let items: DownloadItem[] = [];
    for (let n = 0; n < 55; n++) items = reduceDownloads(items, { type: 'started', item: makeItem(`d${n}`) });
    expect(items).toHaveLength(50);
    expect(items[0].id).toBe('d5');
    expect(items[49].id).toBe('d54');
  });
});

describe('handleWillDownload', () => {
  it('gives concurrent same-name downloads distinct paths, and reuses names only after finish', () => {
    const first = start('race.pdf');
    const second = start('race.pdf');
    expect(first.setSavePath).toHaveBeenCalledWith('/dl/race.pdf');
    expect(second.setSavePath).toHaveBeenCalledWith('/dl/race (1).pdf');
    first.emit('done', {}, 'completed');
    mocks.existsSync.mockImplementation((p: string) => p === '/dl/race.pdf');
    const third = start('race.pdf');
    expect(third.setSavePath).toHaveBeenCalledWith('/dl/race (2).pdf');
    second.emit('done', {}, 'cancelled');
    third.emit('done', {}, 'completed');
  });

  it('cancelling one download never unlinks the file of a same-name download', () => {
    const a = start('twin.pdf');
    const b = start('twin.pdf');
    a.emit('done', {}, 'cancelled');
    expect(mocks.unlink).toHaveBeenCalledWith('/dl/twin.pdf');
    expect(mocks.unlink).not.toHaveBeenCalledWith('/dl/twin (1).pdf');
    b.emit('done', {}, 'completed');
  });

  it('saves under a unique sanitized path and emits started', () => {
    mocks.existsSync.mockImplementation((p: string) => p === '/dl/report.pdf');
    const item = start('../report.pdf');
    expect(item.setSavePath).toHaveBeenCalledWith('/dl/report (1).pdf');
    expect(lastEmitted().at(-1)).toMatchObject({ filename: 'report (1).pdf', state: 'progressing' });
  });

  it('throttles updated emits to 4 per second per item but always emits done', () => {
    vi.useFakeTimers();
    const item = start('t.bin');
    mocks.emit.mockClear();
    item.emit('updated', {}, 'progressing');
    item.emit('updated', {}, 'progressing');
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    item.emit('updated', {}, 'progressing');
    expect(mocks.emit).toHaveBeenCalledTimes(2);
    item.emit('done', {}, 'completed');
    expect(mocks.emit).toHaveBeenCalledTimes(3);
    expect(lastEmitted().at(-1)?.state).toBe('completed');
  });

  it('a cancelled download deletes its partial file', async () => {
    const item = start('big.iso');
    item.emit('done', {}, 'cancelled');
    expect(mocks.unlink).toHaveBeenCalledWith('/dl/big.iso');
  });

  it('a completed download keeps its file', () => {
    const item = start('ok.iso');
    item.emit('done', {}, 'completed');
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it('logs unlink failures other than ENOENT and ignores ENOENT', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.unlink.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }));
    start('a.iso').emit('done', {}, 'cancelled');
    await Promise.resolve();
    await Promise.resolve();
    expect(error).not.toHaveBeenCalled();
    mocks.unlink.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
    start('b.iso').emit('done', {}, 'cancelled');
    await new Promise((r) => setTimeout(r, 0));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('download actions', () => {
  it('openDownload/showDownloadInFolder reject ids not in the list', async () => {
    expect(await openDownload('nope')).toEqual({ success: false, msg: expect.any(String) });
    expect(showDownloadInFolder('nope')).toEqual({ success: false, msg: expect.any(String) });
    expect(cancelDownload('nope').success).toBe(false);
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it('opens and reveals a completed download', async () => {
    start('x.bin').emit('done', {}, 'completed');
    const [tracked] = getDownloads().slice(-1);
    expect(await openDownload(tracked.id)).toEqual({ success: true });
    expect(mocks.openPath).toHaveBeenCalledWith(tracked.savePath);
    expect(showDownloadInFolder(tracked.id)).toEqual({ success: true });
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(tracked.savePath);
  });

  it('refuses to open or reveal a download that is not completed', async () => {
    const item = start('wip.bin');
    const [tracked] = getDownloads().slice(-1);
    expect((await openDownload(tracked.id)).success).toBe(false);
    expect(showDownloadInFolder(tracked.id).success).toBe(false);
    item.emit('done', {}, 'interrupted');
    expect((await openDownload(tracked.id)).success).toBe(false);
    expect(showDownloadInFolder(tracked.id).success).toBe(false);
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.showItemInFolder).not.toHaveBeenCalled();
  });

  it('cancels an in-progress download', () => {
    const item = start('c.bin');
    const [tracked] = getDownloads().slice(-1);
    expect(cancelDownload(tracked.id)).toEqual({ success: true });
    expect(item.cancel).toHaveBeenCalled();
  });

  it('reports a failure from shell.openPath', async () => {
    start('y.bin').emit('done', {}, 'completed');
    const [tracked] = getDownloads().slice(-1);
    mocks.openPath.mockResolvedValueOnce('no app');
    expect(await openDownload(tracked.id)).toEqual({ success: false, msg: 'no app' });
  });
});
