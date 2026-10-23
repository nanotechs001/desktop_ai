/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isSafeUrl } from '@process/services/browserSession/urlSafety';

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };
const METADATA_V6 = '[fd00:ec2::254]';
const MAPPED_V4_PREFIX = '[::ffff:';

/** `[::ffff:a9fe:a9fe]` (how WHATWG URL prints a mapped address) -> `169.254.169.254`; otherwise unchanged. */
const unmapIpv4 = (hostname: string): string => {
  if (!hostname.startsWith(MAPPED_V4_PREFIX)) return hostname;
  const hextets = hostname.slice(MAPPED_V4_PREFIX.length, -1).split(':');
  if (hextets.length !== 2) return hostname;
  const [high, low] = hextets.map((h) => Number.parseInt(h, 16));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
};

const isLinkLocal = (host: string): boolean =>
  host.startsWith('169.254.') || host === METADATA_V6 || /^\[fe[89ab][0-9a-f]?:/.test(host);

const isLoopback = (host: string): boolean =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host.startsWith('127.') ||
  host === '0.0.0.0' ||
  host === '[::1]' ||
  host === '[::]';

/**
 * True when an agent may open or navigate to `url`: http(s) or about:blank, never a link-local or
 * cloud-metadata address, and never one of the app's own loopback ports (the relay, the backend).
 * Other localhost and LAN addresses stay allowed for the user's local dev sites.
 * shortcut: checks the literal host only; a public name that resolves to a blocked address is not caught.
 */
export function isAgentNavigableUrl(url: string, blockedLoopbackPorts: ReadonlySet<number>): boolean {
  if (!isSafeUrl(url)) return false;
  if (url === 'about:blank') return true;
  const parsed = new URL(url);
  // `localhost.`, `localhost..` and `0.0.0.0..` name the same hosts as without the dots; compare them without.
  const host = unmapIpv4(parsed.hostname.replace(/\.+$/, ''));
  if (isLinkLocal(host)) return false;
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORTS[parsed.protocol];
  return !(isLoopback(host) && blockedLoopbackPorts.has(port));
}

const parse = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

const pagePath = (url: URL): string => url.pathname.replace(/\/+$/, '') || '/';

/** The same page: the same address, with the path's trailing slash and the #fragment ignored. */
export function isSamePage(a: string, b: string): boolean {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return a === b;
  return left.origin === right.origin && pagePath(left) === pagePath(right) && left.search === right.search;
}

/**
 * The same site: the host's last two labels match (slack.example.com and app.slack.example.com share example.com).
 * shortcut: no public-suffix list, so example.co.uk and other.co.uk count as one site; upgrade if that matters.
 */
export function isSameSite(a: string, b: string): boolean {
  const site = (url: string) => parse(url)?.hostname.split('.').slice(-2).join('.') ?? null;
  const left = site(a);
  return left !== null && left === site(b);
}
