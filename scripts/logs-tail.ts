import { Logging } from '@google-cloud/logging';
import { createPrettyStream, serviceLogFilter, CLOUD_RUN_PREFIX, type LogSource } from '@cp/logger';
import { loadDotEnv, loadPlatformConfig } from '@cp/platform';

/**
 * `pnpm logs:tail`: streams our services' logs from Cloud Logging into this terminal, formatted
 * like local output. Covers deployed Cloud Run services and local runs with LOG_TO_CLOUD=true.
 *
 *   pnpm logs:tail [-- --service collector|processor] [--source all|cloud_run|local] [--since 10m]
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

loadDotEnv();
const projectId = loadPlatformConfig({ ...process.env, CP_MODE: 'gcp' }).projectId!;
const service = arg('service');
const source = (arg('source') ?? 'all') as LogSource;
const since = arg('since') ?? '10m';
const filter = serviceLogFilter(projectId, { ...(service ? { service } : {}), source });
const logging = new Logging({ projectId });
const pretty = createPrettyStream();

const SEVERITY_TO_LEVEL: Record<string, number> = { DEFAULT: 30, DEBUG: 20, INFO: 30, NOTICE: 30, WARNING: 40, ERROR: 50, CRITICAL: 60, ALERT: 60, EMERGENCY: 60 };

function sinceIso(spec: string): string {
  const m = /^(\d+)([smhd])$/.exec(spec);
  const unit = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 } as const;
  const ms = m ? Number(m[1]) * unit[m[2] as keyof typeof unit] : 6e5;
  return new Date(Date.now() - ms).toISOString();
}

function toMillis(ts: unknown): number {
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'string') return Date.parse(ts);
  if (ts && typeof ts === 'object' && 'seconds' in ts) {
    const t = ts as { seconds: number | string; nanos?: number };
    return Number(t.seconds) * 1000 + Math.floor((t.nanos ?? 0) / 1e6);
  }
  return Date.now();
}

interface EntryLike {
  metadata?: Record<string, unknown>;
  data?: unknown;
}

const seen = new Set<string>();

function print(entry: EntryLike): void {
  const meta = entry.metadata ?? {};
  const id = String(meta.insertId ?? '');
  if (id) {
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 10_000) seen.clear();
  }
  const resourceLabels = ((meta.resource as { labels?: Record<string, string> } | undefined)?.labels ?? {}) as Record<string, string>;
  const labels = (meta.labels ?? {}) as Record<string, string>;
  const payload = entry.data;
  const fields: Record<string, unknown> = typeof payload === 'object' && payload !== null ? { ...(payload as Record<string, unknown>) } : {};
  const svc =
    labels.service ??
    (typeof fields.service === 'string' ? fields.service : undefined) ??
    resourceLabels.service_name?.replace(CLOUD_RUN_PREFIX, '') ??
    'gcp';
  const http = meta.httpRequest as { requestMethod?: string; requestUrl?: string; status?: number; latency?: unknown } | undefined;
  const message =
    typeof payload === 'string'
      ? payload
      : typeof fields.message === 'string'
        ? fields.message
        : http
          ? `${http.requestMethod} ${String(http.requestUrl ?? '').split('?')[0]} ${http.status}`
          : '';
  for (const k of ['message', 'service', 'severity', 'timestamp', 'serviceContext', 'logging.googleapis.com/insertId', 'logging.googleapis.com/trace', 'logging.googleapis.com/spanId', 'logging.googleapis.com/trace_sampled']) {
    delete fields[k];
  }
  const level = SEVERITY_TO_LEVEL[String(meta.severity ?? 'DEFAULT')] ?? 30;
  pretty.write(`${JSON.stringify({ level, time: toMillis(meta.timestamp), service: svc, msg: message, ...fields })}\n`);
}

async function backfill(): Promise<void> {
  const [entries] = await logging.getEntries({
    filter: `(${filter}) AND timestamp>="${sinceIso(since)}"`,
    orderBy: 'timestamp asc',
    pageSize: 500,
    autoPaginate: false,
  });
  for (const e of entries) print(e as unknown as EntryLike);
}

function follow(): void {
  const stream = logging.tailEntries({ resourceNames: [`projects/${projectId}`], filter });
  stream.on('data', (resp: { entries?: EntryLike[] }) => {
    for (const e of resp.entries ?? []) print(e);
  });
  stream.on('error', (err: Error) => {
    process.stderr.write(`[logs] live tail unavailable (${err.message.split('\n')[0]}); polling every 3s instead\n`);
    void poll();
  });
}

async function poll(): Promise<void> {
  let cursor = new Date().toISOString();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const [entries] = await logging.getEntries({ filter: `(${filter}) AND timestamp>="${cursor}"`, orderBy: 'timestamp asc', pageSize: 500, autoPaginate: false });
    for (const e of entries) {
      print(e as unknown as EntryLike);
      cursor = new Date(toMillis((e as unknown as EntryLike).metadata?.timestamp)).toISOString();
    }
  }
}

async function main(): Promise<void> {
  process.stdout.write(`logs: project ${projectId}, ${service ? `service ${service}` : 'all services'}, source ${source}, since ${since}\n`);
  await backfill();
  if (process.argv.includes('--no-follow')) return;
  process.stdout.write('--- following (Ctrl+C to stop) ---\n');
  follow();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const hint = /default credentials/i.test(message) ? '\nHint: run `gcloud auth application-default login`.' : '';
  process.stderr.write(`logs:tail failed: ${message}${hint}\n`);
  process.exit(1);
});
