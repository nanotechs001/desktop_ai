// Spike (verdict 3): serves dist/ under the artifact CSP and renders a TSX artifact compiled in the page by
// Sucrase, using Recharts, lucide-react, react-markdown and Tailwind. Run with Google Chrome via Playwright.
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';

const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'; form-action 'none'; base-uri 'none'";
const source = `
import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis } from 'recharts';
import { Rocket } from 'lucide-react';
import Markdown from 'react-markdown';
type Point = { x: number; y: number };
const data: Point[] = [{ x: 1, y: 2 }, { x: 2, y: 5 }, { x: 3, y: 3 }];
export default function App() {
  const [n, setN] = useState<number>(0);
  return (
    <div className="p-4 text-red-600" id="app">
      <Rocket id="icon" />
      <Markdown>{'# Hello artifact'}</Markdown>
      <LineChart width={300} height={150} data={data}><XAxis dataKey="x" /><YAxis /><Line dataKey="y" isAnimationActive={false} /></LineChart>
      <button id="btn" onClick={() => setN(n + 1)}>{n}</button>
    </div>
  );
}`;
const libs = ['react', 'react-dom', 'recharts', 'lucide-react', 'react-markdown', 'sucrase', 'tailwind'];
const page = `<!doctype html><html><head><link rel="icon" href="data:,">${libs.map((l) => `<script src="/lib/${l}.js"></script>`).join('')}</head>
<body><div id="root"></div><script type="text/plain" id="src">${source}</script><script>
const mods = { react: React, 'react-dom': ReactDOM, 'react-dom/client': ReactDOM, recharts: Recharts, 'lucide-react': LucideReact, 'react-markdown': ReactMarkdown };
try {
  const { code } = Sucrase.transform(document.getElementById('src').textContent, { transforms: ['typescript', 'jsx', 'imports'], production: true });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'React', code)((m) => { if (!(m in mods)) throw new Error('blocked import ' + m); return mods[m]; }, module, module.exports, React);
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(module.exports.default));
} catch (e) { document.title = 'ERROR ' + e.message; }
</script></body></html>`;

const server = http.createServer((req, res) => {
  const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' };
  const lib = /^\/lib\/([a-z-]+)\.js$/.exec(req.url ?? '');
  if (lib && libs.includes(lib[1])) {
    res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript' }).end(fs.readFileSync(`dist/${lib[1]}.js`));
  } else if (req.url === '/a/test') res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }).end(page);
  else res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const tab = await browser.newPage();
const errors = [];
tab.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
tab.on('pageerror', (e) => errors.push(e.message));
await tab.goto(`http://127.0.0.1:${server.address().port}/a/test`);
await tab.waitForSelector('#btn', { timeout: 10_000 }).catch(() => undefined);
await tab.click('#btn').catch(() => undefined);
const result = await tab.evaluate(() => ({
  title: document.title,
  h1: document.querySelector('#app h1')?.textContent ?? null,
  lucideSvg: !!document.querySelector('svg#icon, svg.lucide'),
  rechartsPath: !!document.querySelector('.recharts-line path'),
  clicked: document.querySelector('#btn')?.textContent,
  tailwindColor: getComputedStyle(document.getElementById('app') ?? document.body).color,
}));
console.log(JSON.stringify({ result, errors }, null, 1));
await browser.close();
server.close();
const ok =
  result.h1 === 'Hello artifact' &&
  result.lucideSvg &&
  result.rechartsPath &&
  result.clicked === '1' &&
  result.tailwindColor !== 'rgb(0, 0, 0)' &&
  errors.length === 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
