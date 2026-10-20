/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { encodeFrame, type FrameMeta } from '@process/services/agentBrowser/relay/browserView/protocol';
import { decodeFrame } from '@renderer/components/media/browserLive/frameCodec';

const meta: FrameMeta = {
  offsetTop: 56,
  pageScaleFactor: 1.5,
  deviceWidth: 400,
  deviceHeight: 800,
  scrollOffsetX: 0,
  scrollOffsetY: 300.5,
};

const toArrayBuffer = (buf: Buffer): ArrayBuffer =>
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

const frameWithHeader = (header: string): ArrayBuffer => {
  const bytes = Buffer.from(header, 'utf8');
  const out = Buffer.alloc(4 + bytes.length + 2);
  out.writeUInt32BE(bytes.length);
  bytes.copy(out, 4);
  return toArrayBuffer(out);
};

describe('renderer decodeFrame', () => {
  it("reads main's encodeFrame output", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

    const decoded = decodeFrame(toArrayBuffer(encodeFrame(meta, jpeg)));

    expect(decoded.meta).toEqual(meta);
    expect(Array.from(decoded.jpeg)).toEqual(Array.from(jpeg));
  });

  it('rejects a malformed header', () => {
    const { scrollOffsetY: _omit, ...missingField } = meta;
    expect(() => decodeFrame(frameWithHeader('not json!'))).toThrow();
    expect(() => decodeFrame(frameWithHeader('null'))).toThrow();
    expect(() => decodeFrame(frameWithHeader(JSON.stringify({ ...meta, pageScaleFactor: 0 })))).toThrow();
    expect(() => decodeFrame(frameWithHeader(JSON.stringify(missingField)))).toThrow();
  });

  it('rejects a truncated frame', () => {
    expect(() => decodeFrame(new Uint8Array([0, 0, 0, 99, 1]).buffer)).toThrow();
    expect(() => decodeFrame(new ArrayBuffer(2))).toThrow();
  });
});
