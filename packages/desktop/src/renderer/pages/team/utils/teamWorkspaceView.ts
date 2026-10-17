export type TeamWorkspaceView = {
  workspacePath: string;
  workspaceEnabled: boolean;
  isTemporaryWorkspace: boolean;
};

function cleanWorkspace(value?: string): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveTeamWorkspaceView(teamWorkspace?: string, leaderWorkspace?: string): TeamWorkspaceView {
  const normalizedTeamWorkspace = cleanWorkspace(teamWorkspace);
  const normalizedLeaderWorkspace = cleanWorkspace(leaderWorkspace);
  const workspacePath = normalizedTeamWorkspace || normalizedLeaderWorkspace;
  return {
    workspacePath,
    workspaceEnabled: workspacePath.length > 0,
    isTemporaryWorkspace: !normalizedTeamWorkspace,
  };
}
