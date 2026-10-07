import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { findRepoRoot, loadDotEnv } from '@cp/platform';

/**
 * `pnpm dev`: the whole local stack in one terminal.
 *   collector :8080  processor :8081  api :8082  clusterer :8083  agent :8084   (tsx watch; lines tagged by their logger)
 *   shop      :5173  dashboard :5174                                (Vite; lines prefixed here)
 * `pnpm dev -- --backend` runs only the five Node services.
 */

const root = findRepoRoot();
loadDotEnv(root);
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');
const viteCli = (app: string) => join(dirname(createRequire(join(root, 'apps', app, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');

interface Service {
  name: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Prefix each output line (for tools whose output is not already tagged). */
  prefix?: string;
}

const backendOnly = process.argv.includes('--backend');
const node = (entry: string): string[] => [tsxCli, 'watch', '--clear-screen=false', '--conditions=source', entry];
const services: Service[] = [
  { name: 'collector', args: node(join(root, 'apps', 'collector', 'src', 'index.ts')), cwd: root },
  // PORT from .env belongs to the collector; the processor keeps its own port.
  { name: 'processor', args: node(join(root, 'apps', 'processor', 'src', 'index.ts')), cwd: root, env: { PORT: process.env.PROCESSOR_PORT ?? '8081' } },
  { name: 'api', args: node(join(root, 'apps', 'api', 'src', 'index.ts')), cwd: root },
  { name: 'clusterer', args: node(join(root, 'apps', 'clusterer', 'src', 'index.ts')), cwd: root, env: { PORT: process.env.CLUSTERER_PORT ?? '8083' } },
  { name: 'agent', args: node(join(root, 'apps', 'agent', 'src', 'index.ts')), cwd: root },
  ...(backendOnly
    ? []
    : [
        { name: 'shop', args: [viteCli('demo-shop')], cwd: join(root, 'apps', 'demo-shop'), prefix: '\x1b[33m[shop]\x1b[0m ' },
        { name: 'dashboard', args: [viteCli('dashboard')], cwd: join(root, 'apps', 'dashboard'), prefix: '\x1b[34m[dashboard]\x1b[0m ' },
      ]),
];

process.stdout.write(
  [
    '',
    `  Churn Preventer local stack (CP_MODE=${process.env.CP_MODE ?? 'local'}; all data synthetic)`,
    '  ingest     POST http://localhost:8080/v1/ingest',
    '  api        http://localhost:8082/v1/findings   (ranked findings)   /v1/clusters   /v1/signals',
    `  agent      http://localhost:8084/healthz       (${process.env.GOOGLE_API_KEY ? 'Gemini' : 'offline stand-in: set GOOGLE_API_KEY for Gemini'})`,
    ...(backendOnly
      ? []
      : [
          '  shop       http://localhost:5173/?bugs=dead_button   (click Apply Coupon 6+ times)',
          '  dashboard  http://localhost:5174                     (ranked findings, issues, signals, session replay)',
          '  simulate   pnpm sim -- --sessions 100, then pnpm sim:check',
        ]),
    ...(process.env.LOG_TO_CLOUD === 'true' ? ['  logs are also shipped to Cloud Logging (LOG_TO_CLOUD=true)'] : []),
    '',
  ].join('\n') + '\n',
);

let stopping = false;
const children: ChildProcess[] = services.map((s) => {
  const child = spawn(process.execPath, s.args, {
    cwd: s.cwd,
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1', ...s.env },
    stdio: s.prefix ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
  });
  if (s.prefix) {
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream }).on('line', (line) => {
        if (line.trim() !== '') process.stdout.write(`${s.prefix}${line}\n`);
      });
    }
  }
  child.on('exit', (code, signal) => {
    if (!stopping) process.stderr.write(`[dev] ${s.name} exited (${signal ?? code}); stopping\n`);
    stop(code ?? 1);
  });
  return child;
});

function stop(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null || c.pid === undefined) continue;
    // tsx watch runs the service in a grandchild; on Windows only a tree kill reaches it.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill();
  }
  setTimeout(() => process.exit(code), 500).unref();
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
