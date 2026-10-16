/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A file download started from the in-app browser. */
export type DownloadItem = {
  id: string;
  url: string;
  filename: string;
  savePath: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  /** 0 when the server did not announce a length. */
  totalBytes: number;
};
