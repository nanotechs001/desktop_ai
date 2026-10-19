/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { fromApiSidebar, fromApiSidebarItems } from '@/common/adapter/sidebarMapper';
import type { SidebarItemsResponse, SidebarResponse } from '@/common/types/sidebar';

const conversation = { id: 'conv-1', name: 'Chat', type: 'acp', extra: {}, pinned: true };
// The backend may still send team rows; teams are removed from this app.
const teamRow = { type: 'team', team_id: 'team-1', name: 'Team', updated_at: 1, pinned: false };

describe('sidebarMapper', () => {
  it('keeps conversation rows and drops leftover team rows in sidebar groups', () => {
    const raw = {
      groups: [{ scope: { type: 'chats' }, items: [{ type: 'conversation', conversation }, teamRow], has_more: false }],
      has_more_groups: false,
    } as unknown as SidebarResponse;

    const [group] = fromApiSidebar(raw).groups;

    expect(group.items).toHaveLength(1);
    expect(group.items[0].conversation.id).toBe('conv-1');
    expect(group.items[0].conversation.extra.pinned).toBe(true);
  });

  it('drops leftover team rows from a paged items window', () => {
    const raw = {
      items: [teamRow, { type: 'conversation', conversation }],
      has_more: false,
    } as unknown as SidebarItemsResponse;

    expect(fromApiSidebarItems(raw).items.map((item) => item.conversation.id)).toEqual(['conv-1']);
  });
});
