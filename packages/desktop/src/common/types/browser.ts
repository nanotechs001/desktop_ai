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

/** The only permissions that ever prompt the user; every other one is allowed or denied by policy. */
export type PromptPermission = 'media' | 'geolocation' | 'notifications' | 'clipboard-read' | 'midi' | 'midiSysex';

/** A site permission prompt waiting for the user's answer. */
export type PermissionRequest = {
  id: string;
  origin: string;
  permission: PromptPermission;
  /** `'video'` / `'audio'` for `media` requests; empty otherwise. */
  mediaTypes: string[];
};
