import { observePage, type ActionRow, type Observation } from '@process/resources/builtinMcp/aionBrowser/actionSpace';
import type { CdpConnection } from '@process/services/agentBrowser/cdpConnection';

const WAIT_MS = 5000;

/** Observes until `ready` holds: OOPIFs attach (and nested ones load) a little after the top load event. */
export async function observeUntil(
  conn: CdpConnection,
  sessionId: string,
  ready: (obs: Observation) => boolean,
  deadline = Date.now() + WAIT_MS
): Promise<Observation> {
  const obs = await observePage(conn, sessionId);
  if (ready(obs) || Date.now() > deadline) return obs;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return observeUntil(conn, sessionId, ready, deadline);
}

/** Rows of one frame (by its label) with one control label. */
export const rowsIn = (obs: Observation, frameLabel: string, label: string): ActionRow[] =>
  obs.rows.filter((row) => row.frameLabel === frameLabel && row.label === label);
