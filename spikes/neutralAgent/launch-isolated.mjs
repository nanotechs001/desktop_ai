// Spike probe: launches an isolated AionUi (fresh temp userData, second-instance names, bundled aioncore)
// and keeps it up until <runDir>/stop exists. Writes <runDir>/port (aioncore HTTP port) and app.log.
// Usage: node spikes/neutralAgent/launch-isolated.mjs <runDir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = path.resolve(import.meta.dirname, '../..');
const runDir = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, 'run'));
fs.mkdirSync(runDir, { recursive: true });
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-spike-userdata-'));
const log = fs.createWriteStream(path.join(runDir, 'app.log'));

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  timeout: 90_000,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    AIONUI_E2E_TEST: '1',
    AIONUI_MULTI_INSTANCE: '1',
    AIONUI_E2E_USER_DATA_DIR: userData,
    AIONUI_DISABLE_AUTO_UPDATE: '1',
    AIONUI_DISABLE_DEVTOOLS: '1',
    AIONUI_BACKEND_BIN: path.join(root, 'resources/bundled-aioncore/darwin-arm64/aioncore'),
    // Stand-ins for the env main will export (spec §3.1); verdict 2 checks they reach MCP children.
    AION_ARTIFACTS_URL: 'http://127.0.0.1:1',
    AION_ARTIFACTS_TOKEN: 'spike-dummy',
  },
});
app.process().stdout?.pipe(log);
app.process().stderr?.pipe(log);
fs.writeFileSync(path.join(runDir, 'userData'), userData);
fs.writeFileSync(path.join(runDir, 'pid'), String(app.process().pid));

const page = await app.firstWindow();
await page.waitForFunction(() => Boolean(window.__backendPort), undefined, { timeout: 90_000 });
fs.writeFileSync(path.join(runDir, 'port'), String(await page.evaluate(() => window.__backendPort)));

const stopFile = path.join(runDir, 'stop');
while (!fs.existsSync(stopFile)) await new Promise((r) => setTimeout(r, 500));
await app.evaluate(({ app: a }) => a.exit(0)).catch(() => undefined);
await app.close().catch(() => undefined);
fs.rmSync(userData, { recursive: true, force: true });
process.exit(0);
