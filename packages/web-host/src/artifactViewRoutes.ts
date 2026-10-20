/**
 * The WebUI's view of the desktop's artifacts, answered by the listener itself after the auth gate:
 * `GET /api/artifact-view/a/<id>[/v/<n>]` (a page, session required) and `GET /api/artifact-view/lib/<file>` (a
 * bundled library, open: see classifyRequest). Both are forwarded to the desktop's loopback artifact server with
 * its own Host and no client headers, so no cookie or token ever reaches it. Its token API (`POST /api/artifacts/*`,
 * `/api/notes/*`) has no route here. Response headers, its sandbox CSP included, pass through; no CORS is added.
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { ArtifactViewRoutes } from './types.js';

export const ARTIFACT_VIEW_PREFIX = '/api/artifact-view';
/** The exact routes, on the raw path; the artifact server's own paths are the captured part. */
const ROUTE =
  /^\/api\/artifact-view(\/a\/[A-Za-z0-9_-]{22}(?:\/v\/[1-9]\d{0,8})?|\/lib\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,127})$/;
const UPSTREAM_TIMEOUT_MS = 10_000;

/** True for any path under the prefix, case-insensitively: none of them may ever reach aioncore. */
export const isArtifactViewPath = (normalizedPath: string): boolean => {
  const path = normalizedPath.toLowerCase();
  return path === ARTIFACT_VIEW_PREFIX || path.startsWith(`${ARTIFACT_VIEW_PREFIX}/`);
};

function reply(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error }));
}

/** An artifact-view request the auth gate already passed; `routes` is null when the desktop gave none. */
export function serveArtifactView(req: IncomingMessage, res: ServerResponse, routes: ArtifactViewRoutes | null): void {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return reply(res, 405, 'METHOD_NOT_ALLOWED');
  }
  const match = ROUTE.exec((req.url ?? '').split('?', 1)[0]);
  if (!match) return reply(res, 404, 'NOT_FOUND');
  const port = routes?.port() ?? null;
  if (port === null) return reply(res, 503, 'ARTIFACTS_UNAVAILABLE');

  const upstream = http.get(
    { hostname: '127.0.0.1', port, path: match[1], headers: { host: `127.0.0.1:${port}` }, agent: false },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstream.destroy(new Error('artifact server timed out')));
  upstream.on('error', () => {
    if (!res.headersSent) reply(res, 502, 'ARTIFACTS_UNREACHABLE');
    else res.destroy();
  });
  req.resume(); // a GET body is never forwarded
}
