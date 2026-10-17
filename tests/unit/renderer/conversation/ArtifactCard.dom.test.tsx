import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolMessage } from '@/common/chat/normalizeToolCall';
import { normalizeToolMessages } from '@/common/chat/normalizeToolCall';

const mocks = vi.hoisted(() => ({
  openBrowserTab: vi.fn(),
  copyText: vi.fn(),
  origin: vi.fn(),
  getConversation: vi.fn(),
  navigate: vi.fn(),
  preview: true,
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => (mocks.preview ? { openBrowserTab: mocks.openBrowserTab } : null),
}));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: mocks.copyText }));
vi.mock('@/common', () => ({
  ipcBridge: {
    database: { getConversationMessage: { invoke: vi.fn() } },
    artifacts: { origin: { invoke: mocks.origin } },
    conversation: { get: { invoke: mocks.getConversation } },
  },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));

import ArtifactCardBase, { type ArtifactCardProps } from '@/renderer/pages/conversation/Messages/acp/ArtifactCard';
import MessageToolGroupSummaryBase from '@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary';

const ORIGIN = 'http://127.0.0.1:4300';
const URL_OK = `${ORIGIN}/a/AAAAAAAAAAAAAAAAAAAAAA`;

/** Each render gets its own SWR cache, so one test's artifact origin never leaks into the next. */
const fresh = (ui: React.ReactElement) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>
);
const ArtifactCard: React.FC<ArtifactCardProps> = (props) => fresh(<ArtifactCardBase {...props} />);
const MessageToolGroupSummary: React.FC<React.ComponentProps<typeof MessageToolGroupSummaryBase>> = (props) =>
  fresh(<MessageToolGroupSummaryBase {...props} />);

/** Lets the origin request settle, so a card's absent buttons are really absent, not still loading. */
const originSettled = async () => {
  await waitFor(() => expect(mocks.origin).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
};

beforeEach(() => {
  mocks.openBrowserTab.mockReset();
  mocks.copyText.mockReset().mockResolvedValue(undefined);
  mocks.origin.mockReset().mockResolvedValue({ success: true, data: ORIGIN });
  mocks.getConversation.mockReset().mockResolvedValue({ id: 'c1', assistant: { id: 'sales-agent' } });
  mocks.navigate.mockReset();
  mocks.preview = true;
});

describe('ArtifactCard', () => {
  it('renders title, kind, v2; Open calls openBrowserTab(url); Copy writes the url', async () => {
    render(<ArtifactCard title='Q3 report' kind='html' version={2} url={URL_OK} />);
    expect(screen.getByText('Q3 report')).toBeInTheDocument();
    expect(screen.getByText('html')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();

    // The result url is unversioned; the card pins its own version so an old card keeps showing that version.
    fireEvent.click(await screen.findByRole('button', { name: 'messages.artifactCard.open' }));
    expect(mocks.openBrowserTab).toHaveBeenCalledWith(`${URL_OK}/v/2`);

    fireEvent.click(screen.getByRole('button', { name: 'messages.artifactCard.copyLink' }));
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith(`${URL_OK}/v/2`));
  });

  it('keeps a version suffix that is already in the path', async () => {
    render(<ArtifactCard title='T' version={1} url={`${URL_OK}/v/3`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'messages.artifactCard.open' }));
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
  ])('card with the unsafe url %s renders without buttons', async (url) => {
    render(<ArtifactCard title='Report' kind='html' version={2} url={url} />);
    expect(screen.getByText('Report')).toBeInTheDocument();
    await originSettled();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('treats the title as text, not markup', () => {
    render(<ArtifactCard title='<img src=x onerror=alert(1)>' version={1} url={URL_OK} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('hides Open outside a preview panel but keeps Copy link', async () => {
    mocks.preview = false;
    render(<ArtifactCard title='T' version={1} url={URL_OK} />);
    expect(await screen.findByRole('button', { name: 'messages.artifactCard.copyLink' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'messages.artifactCard.open' })).toBeNull();
  });

  it("builds the link on this launch's origin, not the port stored in an old chat", async () => {
    mocks.origin.mockResolvedValue({ success: true, data: 'http://127.0.0.1:5511' });
    render(<ArtifactCard title='T' version={2} url={URL_OK} />);
    fireEvent.click(await screen.findByRole('button', { name: 'messages.artifactCard.open' }));
    expect(mocks.openBrowserTab).toHaveBeenCalledWith('http://127.0.0.1:5511/a/AAAAAAAAAAAAAAAAAAAAAA/v/2');
  });

  it.each([
    { success: false, msg: 'Artifacts are unavailable' },
    { success: true, data: 'https://evil.example' },
  ])('shows no buttons when the current origin is unusable (%o)', async (reply) => {
    mocks.origin.mockResolvedValue(reply);
    render(<ArtifactCard title='Report' version={1} url={URL_OK} />);
    await originSettled();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
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

describe('MessageToolGroupSummary note chips', () => {
  const noteCall = (over: Record<string, unknown> = {}): ToolMessage =>
    ({
      id: 'm3',
      conversation_id: 'c1',
      type: 'tool_call',
      content: {
        call_id: 'note-1',
        name: 'mcp__aionui-notes__add',
        args: { text: '<b>Prefers</b> metric units' },
        input: { text: '<b>Prefers</b> metric units' },
        status: 'completed',
        output: JSON.stringify({ id: 'n1', saved: true, text: '<b>Prefers</b> metric units', source: 'agent' }),
        ...over,
      },
    }) as unknown as ToolMessage;

  it('shows a "Saved to notebook" chip outside the folded steps, with the note as text and its source', () => {
    const { container } = render(<MessageToolGroupSummary messages={[noteCall()]} />);
    expect(screen.getByText('messages.noteChip.title')).toBeInTheDocument();
    expect(screen.getByText('<b>Prefers</b> metric units')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('messages.noteChip.fromChat')).toBeInTheDocument();
    expect(container.querySelector('.tool-group-summary__body')).toBeNull();
  });

  it("labels a page note as from a page, and opens the chat Agent's notebook in the editor", async () => {
    const output = JSON.stringify({ id: 'n2', saved: true, text: 'Login is at /signin', source: 'page' });
    render(<MessageToolGroupSummary messages={[noteCall({ output })]} />);
    expect(screen.getByText('messages.noteChip.fromPage')).toBeInTheDocument();

    const open = screen.getByRole('button', { name: 'messages.noteChip.open' });
    await waitFor(() => expect(open).not.toBeDisabled());
    fireEvent.click(open);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/assistants', {
        state: { openAssistantEditor: true, openAssistantId: 'sales-agent' },
      })
    );
    expect(mocks.getConversation).toHaveBeenCalledWith({ id: 'c1' });
  });

  it("opens the default Agent's notebook for a chat without an Agent", async () => {
    mocks.getConversation.mockResolvedValue({ id: 'c1' });
    render(<MessageToolGroupSummary messages={[noteCall()]} />);
    const open = screen.getByRole('button', { name: 'messages.noteChip.open' });
    await waitFor(() => expect(open).not.toBeDisabled());
    fireEvent.click(open);
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith('/assistants', {
        state: { openAssistantEditor: true, openAssistantId: 'aion-default-agent' },
      })
    );
  });

  it('shows no chip for a failed or still running add', () => {
    render(
      <MessageToolGroupSummary
        messages={[
          noteCall({ call_id: 'a', status: 'error', output: 'A chat saves at most 10 notes' }),
          noteCall({ call_id: 'b', status: 'running' }),
        ]}
      />
    );
    expect(screen.queryByText('messages.noteChip.title')).toBeNull();
  });
});
