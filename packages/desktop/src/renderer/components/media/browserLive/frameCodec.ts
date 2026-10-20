/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** CDP `Page.screencastFrame` metadata, as main's browser-view protocol sends it in each frame header. */
export type FrameMeta = {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
};

const HEADER_LENGTH_BYTES = 4;
const META_FIELDS = [
  'offsetTop',
  'pageScaleFactor',
  'deviceWidth',
  'deviceHeight',
  'scrollOffsetX',
  'scrollOffsetY',
] as const;

const isFrameMeta = (value: unknown): value is FrameMeta => {
  if (typeof value !== 'object' || value === null) return false;
  const fields = value as Record<string, unknown>;
  return META_FIELDS.every((field) => Number.isFinite(fields[field])) && (fields.pageScaleFactor as number) > 0;
};

/**
 * Renderer side of main's `encodeFrame` (process/services/agentBrowser/relay/browserView/protocol.ts): a 4-byte
 * big-endian header length, the JSON {@link FrameMeta}, then the JPEG bytes. Throws on a truncated frame or a bad header.
 */
export const decodeFrame = (buf: ArrayBuffer): { meta: FrameMeta; jpeg: Uint8Array<ArrayBuffer> } => {
  if (buf.byteLength < HEADER_LENGTH_BYTES) throw new Error('Frame is shorter than its length prefix');
  const headerEnd = HEADER_LENGTH_BYTES + new DataView(buf).getUint32(0);
  if (headerEnd > buf.byteLength) throw new Error('Frame header runs past the end of the frame');
  const header = new TextDecoder().decode(new Uint8Array(buf, HEADER_LENGTH_BYTES, headerEnd - HEADER_LENGTH_BYTES));
  const meta: unknown = JSON.parse(header);
  if (!isFrameMeta(meta)) throw new Error('Frame header is not valid frame metadata');
  return { meta, jpeg: new Uint8Array(buf, headerEnd) };
};
