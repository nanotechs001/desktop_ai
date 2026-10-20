/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

/** The only CDP methods a phone viewer's session may cause. */
export const ALLOWED_VIEWER_METHODS: ReadonlySet<string> = new Set([
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.screencastFrameAck',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
]);

export const ALLOWED_KEYS = [
  'Enter',
  'Backspace',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
] as const;

const MAX_TEXT_CHARS = 2000;
const MAX_VIEWPORT_PX = 10_000;
const MAX_DPR = 10;
const MAX_SCROLL_DELTA_PX = 10_000;

/** A fraction of the frame; out-of-range values are clamped rather than refused. */
const fraction = z
  .number()
  .finite()
  .transform((n) => Math.min(1, Math.max(0, n)));

const clientMessage = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('hello'),
    width: z.number().positive().max(MAX_VIEWPORT_PX),
    dpr: z.number().positive().max(MAX_DPR),
  }),
  z.strictObject({ type: z.literal('ack') }),
  z.strictObject({ type: z.literal('tap'), nx: fraction, ny: fraction }),
  z.strictObject({
    type: z.literal('scroll'),
    nx: fraction,
    ny: fraction,
    dy: z.number().finite().min(-MAX_SCROLL_DELTA_PX).max(MAX_SCROLL_DELTA_PX),
  }),
  z.strictObject({ type: z.literal('text'), value: z.string().max(MAX_TEXT_CHARS) }),
  z.strictObject({ type: z.literal('key'), key: z.enum(ALLOWED_KEYS) }),
  z.strictObject({ type: z.literal('resume') }),
]);

export type ClientMessage = z.infer<typeof clientMessage>;

/** A phone message, or null when it is not valid JSON or not one of the known shapes (the caller ignores it). */
export const parseClientMessage = (raw: string): ClientMessage | null => {
  try {
    const parsed = clientMessage.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const finite = z.number().finite();
const frameMetaSchema = z.object({
  offsetTop: finite,
  pageScaleFactor: finite.positive(),
  deviceWidth: finite,
  deviceHeight: finite,
  scrollOffsetX: finite,
  scrollOffsetY: finite,
});

/** CDP `Page.screencastFrame` metadata. */
export type FrameMeta = z.infer<typeof frameMetaSchema>;

/**
 * Frame fraction -> CSS px for `Input.dispatchMouseEvent`. The frame excludes `offsetTop` and CDP `Input` is
 * viewport-relative, so neither `offsetTop` nor the scroll offsets enter. Only `DOM.getNodeForLocation` wants document
 * coordinates (docs/superpowers/spikes/2026-10-16-phase0-results.md, finding 2).
 */
export const mapTap = (nx: number, ny: number, meta: FrameMeta): { x: number; y: number } => ({
  x: (nx * meta.deviceWidth) / meta.pageScaleFactor,
  y: (ny * meta.deviceHeight) / meta.pageScaleFactor,
});

const HEADER_LENGTH_BYTES = 4;

/** Wire frame: 4-byte big-endian header length, the JSON {@link FrameMeta}, then the JPEG bytes. */
export const encodeFrame = (meta: FrameMeta, jpeg: Buffer): Buffer => {
  const header = Buffer.from(JSON.stringify(meta), 'utf8');
  const length = Buffer.alloc(HEADER_LENGTH_BYTES);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, jpeg]);
};

/** Inverse of {@link encodeFrame}; only DataView and TextDecoder, so the phone bundle can import it. Throws on a truncated frame or an invalid header. */
export const decodeFrame = (buf: ArrayBuffer): { meta: FrameMeta; jpeg: Uint8Array } => {
  if (buf.byteLength < HEADER_LENGTH_BYTES) throw new Error('Frame is shorter than its length prefix');
  const headerEnd = HEADER_LENGTH_BYTES + new DataView(buf).getUint32(0);
  if (headerEnd > buf.byteLength) throw new Error('Frame header runs past the end of the frame');
  const header = new TextDecoder().decode(new Uint8Array(buf, HEADER_LENGTH_BYTES, headerEnd - HEADER_LENGTH_BYTES));
  return { meta: frameMetaSchema.parse(JSON.parse(header)), jpeg: new Uint8Array(buf, headerEnd) };
};
