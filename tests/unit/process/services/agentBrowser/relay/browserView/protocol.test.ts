import { describe, expect, it } from 'vitest';
import {
  ALLOWED_KEYS,
  ALLOWED_VIEWER_METHODS,
  encodeFrame,
  mapTap,
  parseClientMessage,
  type FrameMeta,
} from '@process/services/agentBrowser/relay/browserView/protocol';

const meta: FrameMeta = {
  offsetTop: 0,
  pageScaleFactor: 1,
  deviceWidth: 400,
  deviceHeight: 800,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
};
const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

describe('parseClientMessage', () => {
  it('parses each valid message type', () => {
    expect(parse({ type: 'hello', width: 390, dpr: 3 })).toEqual({ type: 'hello', width: 390, dpr: 3 });
    expect(parse({ type: 'ack' })).toEqual({ type: 'ack' });
    expect(parse({ type: 'tap', nx: 0.25, ny: 0.75 })).toEqual({ type: 'tap', nx: 0.25, ny: 0.75 });
    expect(parse({ type: 'scroll', nx: 0.5, ny: 0.5, dy: -120 })).toEqual({
      type: 'scroll',
      nx: 0.5,
      ny: 0.5,
      dy: -120,
    });
    expect(parse({ type: 'text', value: 'hi' })).toEqual({ type: 'text', value: 'hi' });
    expect(parse({ type: 'key', key: 'Enter' })).toEqual({ type: 'key', key: 'Enter' });
  });

  it('accepts every allowed key and nothing else', () => {
    for (const key of ALLOWED_KEYS) expect(parse({ type: 'key', key })).toEqual({ type: 'key', key });
    expect(parse({ type: 'key', key: 'a' })).toBeNull();
  });

  it('returns null for bad JSON, unknown types and bad fields', () => {
    expect(parseClientMessage('{nope')).toBeNull();
    expect(parseClientMessage('"tap"')).toBeNull();
    expect(parse({ type: 'launch-missiles' })).toBeNull();
    expect(parse({ type: 'resume' })).toBeNull();
    expect(parse({ type: 'text', value: 'a'.repeat(2001) })).toBeNull();
    expect(parse({ type: 'text', value: 'a'.repeat(2000) })).not.toBeNull();
    expect(parse({ type: 'tap', nx: '0.5', ny: 0.5 })).toBeNull();
    expect(parse({ type: 'tap', nx: Number.NaN, ny: 0.5 })).toBeNull();
    expect(parse({ type: 'hello', width: 0, dpr: 2 })).toBeNull();
  });

  it('rejects unknown fields, non-finite numbers and JSON null', () => {
    expect(parseClientMessage('{"type":"ack","x":1}')).toBeNull();
    expect(parseClientMessage('{"type":"tap","nx":1e999,"ny":0}')).toBeNull();
    expect(parseClientMessage('null')).toBeNull();
  });

  it('clamps coordinates to 0..1', () => {
    expect(parse({ type: 'tap', nx: 1.5, ny: -3 })).toEqual({ type: 'tap', nx: 1, ny: 0 });
    expect(parse({ type: 'scroll', nx: 2, ny: -1, dy: 5 })).toMatchObject({ nx: 1, ny: 0 });
  });
});

describe('mapTap', () => {
  it('maps normalised taps to CSS px at pageScaleFactor 1 and 2', () => {
    expect(mapTap(0.5, 0.5, meta)).toEqual({ x: 200, y: 400 });
    expect(mapTap(0.5, 0.5, { ...meta, pageScaleFactor: 2 })).toEqual({ x: 100, y: 200 });
  });

  it('ignores offsetTop and scroll offsets (CDP Input is viewport-relative)', () => {
    expect(mapTap(0.5, 0.5, { ...meta, offsetTop: 56 })).toEqual({ x: 200, y: 400 });
    expect(mapTap(0.5, 0.5, { ...meta, scrollOffsetY: 300, scrollOffsetX: 40 })).toEqual({ x: 200, y: 400 });
  });
});

describe('frame encoding', () => {
  it('lays out a 4-byte big-endian header length, the JSON meta, then the jpeg bytes', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const full: FrameMeta = { ...meta, offsetTop: 56, pageScaleFactor: 1.5, scrollOffsetY: 300.5 };
    const encoded = encodeFrame(full, jpeg);
    const headerEnd = 4 + encoded.readUInt32BE(0);
    expect(JSON.parse(encoded.subarray(4, headerEnd).toString('utf8'))).toEqual(full);
    expect(Array.from(encoded.subarray(headerEnd))).toEqual(Array.from(jpeg));
  });
});

describe('ALLOWED_VIEWER_METHODS', () => {
  it('is exactly the screencast, input and focus-emulation methods the viewer needs', () => {
    expect([...ALLOWED_VIEWER_METHODS].sort()).toEqual([
      'Emulation.setFocusEmulationEnabled',
      'Input.dispatchKeyEvent',
      'Input.dispatchMouseEvent',
      'Input.insertText',
      'Page.screencastFrameAck',
      'Page.startScreencast',
      'Page.stopScreencast',
    ]);
  });
});
