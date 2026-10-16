import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import { normalizeToolMessages } from '@/common/chat/normalizeToolCall';

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

    // The result url is unversioned; the card pins its own version so an old card keeps showing that version.
    fireEvent.click(screen.getByRole('button', { name: 'messages.artifactCard.open' }));
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(`${URL_OK}/v/2`);

    fireEvent.click(screen.getByRole('button', { name: 'messages.artifactCard.copyLink' }));
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith(`${URL_OK}/v/2`));
  });

  it('keeps a version suffix that is already in the path', () => {
    render(<ArtifactCard title='T' version={1} url={`${URL_OK}/v/3`} />);
    fireEvent.click(screen.getByRole('button', { name: 'messages.artifactCard.open' }));
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(`${URL_OK}/v/3`);
  });

  it('shows "Artifact · v2" cleanly when an update carries no title or kind', () => {
    const { container } = render(<ArtifactCard version={2} url={URL_OK} />);
    expect(container.textContent).toMatch(/^messages\.artifactCard\.title\s*·\s*v2/);
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
  const result = JSON.stringify({ id: 'AAAAAAAAAAAAAAAAAAAAAA', version: 2, url: URL_OK });
  const acpMessage = (output: string, status = 'completed'): ToolMessage =>
    ({
      id: 'm1',
      conversation_id: 'c1',
      type: 'acp_tool_call',
      content: {
        update: {
          sessionUpdate: 'tool_call_update',
          tool_call_id: 't1',
          status,
          title: 'mcp__aionui-artifacts__create',
          kind: 'execute',
          rawInput: { title: 'Q3 report', kind: 'html', content: '<p>hi</p>' },
          content: [{ type: 'content', content: { type: 'text', text: output } }],
        },
      },
    }) as unknown as ToolMessage;
  const toolCall = (over: Record<string, unknown>): ToolMessage =>
    ({
      id: 'm2',
      conversation_id: 'c1',
      type: 'tool_call',
      content: {
        call_id: 'call-1',
        name: 'mcp__aionui-artifacts__create',
        args: { title: 'Q3 report', kind: 'html', content: '<p>hi</p>' },
        input: { title: 'Q3 report', kind: 'html', content: '<p>hi</p>' },
        status: 'completed',
        output: result,
        ...over,
      },
    }) as unknown as ToolMessage;

  it('shows the card with the steps collapsed, and no card for a malformed result', () => {
    const { unmount } = render(<MessageToolGroupSummary messages={[acpMessage(result)]} />);
    expect(screen.getByText('Q3 report')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.queryByText('mcp__aionui-artifacts__create')).toBeNull();
    unmount();

    render(<MessageToolGroupSummary messages={[acpMessage('oops')]} />);
    expect(screen.queryByText('v2')).toBeNull();
    fireEvent.click(screen.getByText('View Steps · 1'));
    expect(screen.getByText('mcp__aionui-artifacts__create')).toBeInTheDocument();
  });

  it('shows no card unless the call completed, even with a valid result', () => {
    render(<MessageToolGroupSummary messages={[acpMessage(result, 'failed')]} />);
    expect(screen.queryByText('v2')).toBeNull();
    expect(screen.queryByText('Q3 report')).toBeNull();
  });

  it('shows one card per completed call', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          toolCall({ call_id: 'a' }),
          toolCall({ call_id: 'b', status: 'running' }),
          toolCall({ call_id: 'c', status: 'error' }),
        ]}
      />
    );
    expect(screen.getAllByText('v2')).toHaveLength(1);
  });

  it('renders the card for the real tool_call message shape via normalizeToolMessages', () => {
    const messages = [toolCall({})];
    expect(normalizeToolMessages(messages)[0].artifact).toMatchObject({ title: 'Q3 report', kind: 'html', version: 2 });
    render(<MessageToolGroupSummary messages={messages} />);
    expect(screen.getByText('Q3 report')).toBeInTheDocument();
    expect(screen.getByText('html')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
  });

  it('takes title and kind from args when input is an empty object', () => {
    const messages = [toolCall({ input: {} })];
    expect(normalizeToolMessages(messages)[0].artifact).toMatchObject({ title: 'Q3 report', kind: 'html' });
  });

  it('shows no card when the tool_call output is missing', () => {
    const messages = [toolCall({ output: undefined })];
    expect(normalizeToolMessages(messages)[0].artifact).toBeUndefined();
    render(<MessageToolGroupSummary messages={messages} />);
    expect(screen.queryByText('v2')).toBeNull();
  });
});
