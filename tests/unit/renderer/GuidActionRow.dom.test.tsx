/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import GuidActionRow from '@/renderer/pages/guid/components/GuidActionRow';
import type { IMcpServer, IProvider } from '@/common/config/storage';
import { ipcBridge } from '@/common';
import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';

const environment = vi.hoisted(() => ({ isMobile: false, isDesktop: true }));

vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: {
      showOpen: { invoke: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: environment.isMobile }),
}));

vi.mock('@/renderer/components/agent/AgentModeSelector', () => ({
  default: () => <div data-testid='agent-mode-selector' />,
}));

vi.mock('@/renderer/components/chat/MobileActionSheet', () => ({
  default: ({
    entries,
  }: {
    entries: Array<{
      key: string;
      label: string;
      onClick?: () => void;
      submenu?: { options: Array<{ key: string; label: string; description?: string }> };
    }>;
  }) => (
    <div data-testid='mobile-action-sheet'>
      {entries.map((entry) => (
        <React.Fragment key={entry.key}>
          <button type='button' data-testid={entry.key} onClick={entry.onClick}>
            {entry.label}
          </button>
          {entry.submenu?.options.map((option) => (
            <span key={option.key} data-testid={`option-${option.key}`}>
              {option.label}
              {option.description}
            </span>
          ))}
        </React.Fragment>
      ))}
    </div>
  ),
}));

vi.mock('@/renderer/services/FileService', () => ({
  getCleanFileNames: (files: string[]) => files,
  FileService: { processDroppedFiles: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => environment.isDesktop,
}));

vi.mock('@icon-park/react', () => {
  const Icon = () => <span aria-hidden='true' />;
  return {
    ArrowUp: Icon,
    Brain: Icon,
    FolderOpen: Icon,
    FolderUpload: Icon,
    Lightning: Icon,
    Paperclip: Icon,
    Plus: Icon,
    Search: Icon,
    Shield: Icon,
    UploadOne: Icon,
  };
});

vi.mock('@arco-design/web-react', () => {
  const Menu = Object.assign(
    ({ children, className }: { children?: React.ReactNode; className?: string }) => (
      <div data-testid='dropdown-menu' className={className}>
        {children}
      </div>
    ),
    {
      Item: ({
        children,
        className,
        onClick,
      }: {
        children?: React.ReactNode;
        className?: string;
        onClick?: (e: React.MouseEvent) => void;
      }) => (
        <div role='menuitem' className={className} onClick={onClick}>
          {children}
        </div>
      ),
      // SubMenu renders both the title row and its children so tests can inspect both levels.
      SubMenu: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
        <div role='group'>
          <div data-testid='submenu-title'>{title}</div>
          <div data-testid='submenu-body'>{children}</div>
        </div>
      ),
    }
  );
  return {
    Button: ({
      children,
      disabled,
      onClick,
      ...props
    }: {
      children?: React.ReactNode;
      disabled?: boolean;
      onClick?: () => void;
      [key: string]: unknown;
    }) => (
      <button type='button' disabled={disabled} onClick={onClick} {...props}>
        {children}
      </button>
    ),
    Checkbox: ({
      children,
      checked,
      disabled,
      onChange,
    }: {
      children?: React.ReactNode;
      checked?: boolean;
      disabled?: boolean;
      onChange?: () => void;
    }) => (
      <label>
        <input type='checkbox' checked={checked ?? false} disabled={disabled} onChange={() => onChange?.()} />
        {children}
      </label>
    ),
    Dropdown: ({ children, droplist }: { children?: React.ReactNode; droplist?: React.ReactNode }) => (
      <div>
        {children}
        {droplist}
      </div>
    ),
    Menu,
    Message: { success: vi.fn(), error: vi.fn() },
    Tooltip: ({ children, content }: { children?: React.ReactNode; content?: React.ReactNode }) => (
      <span title={typeof content === 'string' ? content : undefined}>{children}</span>
    ),
  };
});

const makeSkills = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `skill-${i}`, description: '', isAuto: false }));

const makeMcpServers = (count: number): IMcpServer[] =>
  Array.from({ length: count }, (_, i) => ({ id: `mcp-${i}`, name: `server-${i}` }) as IMcpServer);

const renderActionRow = (overrides: Partial<React.ComponentProps<typeof GuidActionRow>> = {}) =>
  render(
    <GuidActionRow
      files={[]}
      onFilesUploaded={vi.fn()}
      modelSelectorNode={null}
      isGeminiMode={false}
      modelList={[]}
      current_model={undefined}
      setCurrentModel={vi.fn()}
      currentAcpCachedModelInfo={null}
      selectedAcpModel={null}
      setSelectedAcpModel={vi.fn()}
      selectedMode=''
      onModeSelect={vi.fn()}
      allSkills={makeSkills(8)}
      disabledBuiltinSkills={[]}
      enabledSkills={[]}
      onToggleSkill={vi.fn()}
      mcpServers={makeMcpServers(8)}
      selectedMcpServerIds={[]}
      onToggleMcpServer={vi.fn()}
      loading={false}
      isButtonDisabled={false}
      onSend={vi.fn()}
      {...overrides}
    />
  );

describe('GuidActionRow skill/MCP submenu search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environment.isMobile = false;
    environment.isDesktop = true;
  });

  it('offers both host files and device upload in the mobile WebUI action sheet', () => {
    environment.isMobile = true;
    environment.isDesktop = false;
    renderActionRow({ allSkills: [], mcpServers: [] });

    expect(screen.getByTestId('attach-host-files')).toHaveTextContent('Add files');
    expect(screen.getByTestId('attach-my-device')).toHaveTextContent('Upload from device');
  });

  it('lists mobile model options without the provider name', () => {
    environment.isMobile = true;
    environment.isDesktop = false;
    renderActionRow({
      allSkills: [],
      mcpServers: [],
      isGeminiMode: true,
      modelList: [{ id: 'p1', name: 'Anthropic', models: ['claude-sonnet-4'] } as unknown as IProvider],
    });

    expect(screen.getByTestId('option-p1::claude-sonnet-4')).toHaveTextContent(/^claude-sonnet-4$/);
    expect(screen.queryByText(/Anthropic/)).not.toBeInTheDocument();
  });

  it('adds files selected from the host picker in mobile WebUI', async () => {
    environment.isMobile = true;
    environment.isDesktop = false;
    const onFilesPicked = vi.fn();
    vi.mocked(ipcBridge.dialog.showOpen.invoke).mockResolvedValue(['/host/project/a.txt']);
    renderActionRow({ allSkills: [], mcpServers: [], onFilesPicked });

    fireEvent.click(screen.getByTestId('attach-host-files'));

    await waitFor(() => expect(onFilesPicked).toHaveBeenCalledWith(['/host/project/a.txt']));
  });

  it('shows both search boxes when skills and MCP servers exceed the threshold', () => {
    renderActionRow();

    expect(screen.getByTestId('guid-skill-search')).toBeInTheDocument();
    expect(screen.getByTestId('guid-mcp-search')).toBeInTheDocument();
  });

  it('hides the search boxes when the lists are at or below the threshold', () => {
    renderActionRow({ allSkills: makeSkills(5), mcpServers: makeMcpServers(5) });

    expect(screen.queryByTestId('guid-skill-search')).not.toBeInTheDocument();
    expect(screen.queryByTestId('guid-mcp-search')).not.toBeInTheDocument();
    // Lists still render in full.
    expect(screen.getByText('skill-4')).toBeInTheDocument();
    expect(screen.getByText('server-4')).toBeInTheDocument();
  });

  it('filters skills case-insensitively and keeps other items hidden', () => {
    renderActionRow();

    fireEvent.change(screen.getByTestId('guid-skill-search'), { target: { value: 'SKILL-3' } });

    expect(screen.getByText('skill-3')).toBeInTheDocument();
    expect(screen.queryByText('skill-4')).not.toBeInTheDocument();
    // MCP list is untouched by the skill query.
    expect(screen.getByText('server-4')).toBeInTheDocument();
  });

  it('filters MCP servers independently from skills', () => {
    renderActionRow();

    fireEvent.change(screen.getByTestId('guid-mcp-search'), { target: { value: 'server-2' } });

    expect(screen.getByText('server-2')).toBeInTheDocument();
    expect(screen.queryByText('server-3')).not.toBeInTheDocument();
    expect(screen.getByText('skill-3')).toBeInTheDocument();
  });

  it('shows an empty state when no skill matches', () => {
    renderActionRow();

    fireEvent.change(screen.getByTestId('guid-skill-search'), { target: { value: 'zzz' } });

    expect(screen.getByText('No matching skills.')).toBeInTheDocument();
  });

  it('shows an empty state when no MCP server matches', () => {
    renderActionRow();

    fireEvent.change(screen.getByTestId('guid-mcp-search'), { target: { value: 'zzz' } });

    expect(screen.getByText('No servers found matching your criteria')).toBeInTheDocument();
  });

  it('still toggles a skill from a filtered list', () => {
    const onToggleSkill = vi.fn();
    renderActionRow({ onToggleSkill });

    fireEvent.change(screen.getByTestId('guid-skill-search'), { target: { value: 'skill-3' } });
    fireEvent.click(screen.getByText('skill-3').closest('[role="menuitem"]')!);

    expect(onToggleSkill).toHaveBeenCalledWith('skill-3', false);
  });

  describe('built-in browser MCP row', () => {
    const browserServer = { id: 'builtin-browser', name: BUILTIN_BROWSER_MCP_NAME, builtin: true } as IMcpServer;

    it('renders checked and disabled with the always-on tooltip, even when not in the selection', () => {
      renderActionRow({ mcpServers: [browserServer], selectedMcpServerIds: [] });

      const checkbox = screen.getByRole('checkbox', { name: new RegExp(BUILTIN_BROWSER_MCP_NAME) });
      expect(checkbox).toBeChecked();
      expect(checkbox).toBeDisabled();
      expect(screen.getByTitle('mcp.browserAlwaysOn')).toBeInTheDocument();
    });

    it('leaves a user server named like the built-in selectable', () => {
      const impostor = { id: 'impostor', name: BUILTIN_BROWSER_MCP_NAME } as IMcpServer;
      renderActionRow({ mcpServers: [impostor], selectedMcpServerIds: [] });

      const checkbox = screen.getByRole('checkbox', { name: new RegExp(BUILTIN_BROWSER_MCP_NAME) });
      expect(checkbox).not.toBeChecked();
      expect(checkbox).not.toBeDisabled();
    });

    it('never toggles the browser row', () => {
      const onToggleMcpServer = vi.fn();
      renderActionRow({ mcpServers: [browserServer], onToggleMcpServer });

      fireEvent.click(screen.getByText(BUILTIN_BROWSER_MCP_NAME).closest('[role="menuitem"]')!);

      expect(onToggleMcpServer).not.toHaveBeenCalled();
    });
  });
});
