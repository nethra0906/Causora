/**
 * One-command launcher: platform + three services (+ optional Vite dev server).
 *   npm start          platform serves the built UI if web/dist exists
 *   npm run dev        also starts Vite on :5173 with hot reload
 *   --fresh            wipe ./data first
 * Footprint: five Node processes (this launcher + platform + three services), ≈ 0.4 GB working set
 * measured after a full evaluation run, and no containers.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { PORTS } from '../src/contracts/index.ts';

const args = new Set(process.argv.slice(2));
/** Vite's JS entry, run with this Node binary: no shell, no .cmd shims, same behaviour on every OS. */
const VITE = 'node_modules/vite/bin/vite.js';
const dataDir = process.env.CAUSORA_DATA_DIR ?? 'data';
if (args.has('--fresh')) rmSync(dataDir, { recursive: true, force: true });

// First run: build the UI once so `npm start` is the only command a newcomer needs.
if (!args.has('--web') && !existsSync('web/dist/index.html')) {
  console.log('Building the UI (first run only)…');
  const r = spawnSync(process.execPath, [VITE, 'build', '--config', 'web/vite.config.ts', '--logLevel', 'warn'], { stdio: 'inherit' });
  if (r.status !== 0) console.error('UI build failed - the API still works; run `npm run build:web` to see why.');
}

const env = {
  ...process.env,
  CAUSORA_DATA_DIR: dataDir,
  CAUSORA_FAULTS_ENABLED: 'true',
  CAUSORA_FAULT_TOKEN: process.env.CAUSORA_FAULT_TOKEN ?? randomBytes(16).toString('hex'),
  CAUSORA_PLATFORM_URL: `http://127.0.0.1:${PORTS.platform}`,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
};

const node = ['--disable-warning=ExperimentalWarning'];
const children: ChildProcess[] = [];
const run = (name: string, cmd: string, argv: string[]) => {
  const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${name}]`;
  child.stdout?.on('data', (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}\n`).join('')));
  child.stderr?.on('data', (d) => process.stderr.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}\n`).join('')));
  child.on('exit', (code) => { if (code) console.error(`${tag} exited with ${code}`); });
  children.push(child);
};

const stop = () => { for (const c of children) c.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

run('platform', process.execPath, [...node, 'scripts/platform.ts']);
for (const s of ['order', 'inventory', 'payment']) run(s, process.execPath, [...node, 'scripts/service.ts', s]);
if (args.has('--web')) run('web', process.execPath, [VITE, '--config', 'web/vite.config.ts']);

const healthy = async (url: string) => { try { return (await fetch(url, { signal: AbortSignal.timeout(400) })).ok; } catch { return false; } };
const deadline = Date.now() + 30_000;
const targets = [PORTS.platform, PORTS.order, PORTS.inventory, PORTS.payment];
for (;;) {
  const ok = await Promise.all(targets.map((p) => healthy(p === PORTS.platform ? `http://127.0.0.1:${p}/api/v1/rulesets` : `http://127.0.0.1:${p}/healthz`)));
  if (ok.every(Boolean)) break;
  if (Date.now() > deadline) { console.error('stack did not become healthy within 30s'); stop(); }
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`\nCausora is up.\n  UI / API   http://127.0.0.1:${PORTS.platform}${args.has('--web') ? '   (dev UI: http://localhost:5173)' : ''}\n  next:      npm run seed   then   npm run demo:primary-failure\n`);
