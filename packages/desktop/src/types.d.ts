declare module '@xterm/headless/lib-headless/xterm-headless.js';
declare module 'diff';

/** `import text from './file?raw'`: the file's contents as a string (Vite/vitest; esbuild via scripts/build-mcp-servers.js). */
declare module '*?raw' {
  const content: string;
  export default content;
}

declare module 'cookie' {
  export type CookieParseOptions = {
    decode?: (value: string) => string;
  };

  export function parse(cookieHeader: string, options?: CookieParseOptions): Record<string, string>;
}
