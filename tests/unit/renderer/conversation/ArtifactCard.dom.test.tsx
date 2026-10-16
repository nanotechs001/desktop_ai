import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';

const mocks = vi.hoisted(() => ({ openBrowserTab: vi.fn(), copyText: vi.fn(), preview: true }));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => (mocks.preview ? { openBrowserTab: mocks.openBrowserTab } : null),
}));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: mocks.copyText }));
vi.mock('@/common', () => ({ ipcBridge: { database: { getConversationMessage: { invoke: vi.fn() } } } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

import ArtifactCard from '@/renderer/pages/conversation/Messages/acp/ArtifactCard';
import MessageToolGroupSummary from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';

const URL_OK = 'http://127.0.0.1:4300/a/AAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  mocks.openBrowserTab.mockReset();
  mocks.copyText.mockReset().mockResolvedValue(undefined);
  mocks.preview = true;
});

describe('ArtifactCard', () => {
  it('renders title, kind, v2; Open calls openBrowserTab(url); Copy writes the url', async () => {
    render(<ArtifactCard title='Q3 report' kind='html' version={2} url={URL_OK} />);
    expect(screen.getByText('Q3 report')).toBeInTheDocument();
    expect(screen.getByText('html')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'messages.artifactCard.open' }));
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(URL_OK);

    fireEvent.click(screen.getByRole('button', { name: 'messages.artifactCard.copyLink' }));
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith(URL_OK));
  });

  it('accepts a version suffix in the path', () => {
    render(<ArtifactCard title='T' version={1} url={`${URL_OK}/v/3`} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it.each([
    'http://localhost:4300/a/AAAAAAAAAAAAAAAAAAAAAA',
    'https://127.0.0.1:4300/a/AAAAAAAAAAAAAAAAAAAAAA',
    'http://127.0.0.1/a/AAAAAAAAAAAAAAAAAAAAAA',
    'http://127.0.0.1:4300/a/short',
    'http://127.0.0.1:4300/a/AAAAAAAAAAAAAAAAAAAAAA/v/0',
    'http://127.0.0.1:4300/other',
    'http://user@127.0.0.1:4300/a/AAAAAAAAAAAAAAAAAAAAAA',
    'http://127.0.0.1:4300@evil.example/a/AAAAAAAAAAAAAAAAAAAAAA',
    'javascript:alert(1)',
    'not a url',
  ])('card with the unsafe url %s renders without buttons', (url) => {
    render(<ArtifactCard title='Report' kind='html' version={2} url={url} />);
    expect(screen.getByText('Report')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('treats the title as text, not markup', () => {
    render(<ArtifactCard title='<img src=x onerror=alert(1)>' version={1} url={URL_OK} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('hides Open outside a preview panel but keeps Copy link', () => {
    mocks.preview = false;
    render(<ArtifactCard title='T' version={1} url={URL_OK} />);
    expect(screen.queryByRole('button', { name: 'messages.artifactCard.open' })).toBeNull();
    expect(screen.getByRole('button', { name: 'messages.artifactCard.copyLink' })).toBeInTheDocument();
  });
});

describe('MessageToolGroupSummary artifact cards', () => {
  const message = (output: string): ToolMessage =>
    ({
      id: 'm1',
      conversation_id: 'c1',
      type: 'acp_tool_call',
      content: {
        update: {
          sessionUpdate: 'tool_call_update',
          tool_call_id: 't1',
          status: 'completed',
          title: 'mcp__aionui-artifacts__create',
          kind: 'execute',
          rawInput: { title: 'Q3 report', kind: 'html', content: '<p>hi</p>' },
          content: [{ type: 'content', content: { type: 'text', text: output } }],
        },
      },
    }) as unknown as ToolMessage;

  it('shows the card for a create result and the plain row for a malformed one', () => {
    const { unmount } = render(
      <MessageToolGroupSummary messages={[message(JSON.stringify({ id: 'x', version: 2, url: URL_OK }))]} />
    );
    fireEvent.click(screen.getByText('View Steps · 1'));
    expect(screen.getByText('Q3 report')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    unmount();

    render(<MessageToolGroupSummary messages={[message('oops')]} />);
    fireEvent.click(screen.getByText('View Steps · 1'));
    expect(screen.getByText('mcp__aionui-artifacts__create')).toBeInTheDocument();
    expect(screen.queryByText('v2')).toBeNull();
  });
});
