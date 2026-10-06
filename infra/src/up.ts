import { BigQuery } from '@google-cloud/bigquery';
import { PubSub } from '@google-cloud/pubsub';
import { Storage } from '@google-cloud/storage';
import { logsExplorerUrl, serviceLogFilter } from '@cp/logger';
import { CLUSTERED_COLLECTION, CLUSTERS_COLLECTION, loadDotEnv, PROCESSED_COLLECTION, TAILS_COLLECTION } from '@cp/platform';
import { BQ_TABLES } from '@cp/schema';
import { loadInfraConfig, type InfraConfig } from './config.js';
import { describe, hasGcloud, run, type CmdResult } from './gcloud.js';
import {
  bindingArgs,
  bucketSpec,
  clustersIndexArgs,
  eventsRawSubscriptionSpec,
  lifecycleRule,
  projectBindings,
  resourceBindings,
  signalsSubscriptionSpec,
  tableSpec,
  viewSpecs,
} from './resources.js';

/**
 * `pnpm infra:up`: creates (or brings up to date) every GCP resource the pipeline needs, in one
 * region. Idempotent: existing resources are left alone or patched, never deleted.
 * `pnpm infra:up -- --dry-run` prints what it would do without touching GCP.
 */

const dryRun = process.argv.includes('--dry-run');
const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const step = (title: string) => out(`\n> ${title}`);
const ok = (s: string) => out(`  ok   ${s}`);
const skip = (s: string) => out(`  --   ${s}`);
const warn = (s: string) => out(`  WARN ${s}`);

let cfg: InfraConfig;

function gcloud(args: string[], opts: { input?: string; allowFail?: boolean } = {}): CmdResult {
  const full = [...args, `--project=${cfg.projectId}`];
  if (dryRun) {
    out(`  $ ${describe('gcloud', full)}${opts.input !== undefined ? '  (value on stdin)' : ''}`);
    return { ok: true, code: 0, stdout: '', stderr: '' };
  }
  const r = run('gcloud', full, opts.input !== undefined ? { input: opts.input } : {});
  if (!r.ok && !opts.allowFail) throw new Error(`${describe('gcloud', full)}\n${r.stderr}`);
  return r;
}

/** True when a describe command succeeds. Always false in a dry run, so the create is printed. */
function exists(args: string[]): boolean {
  if (dryRun) return false;
  return run('gcloud', [...args, `--project=${cfg.projectId}`, '--quiet']).ok;
}

function preflight(): { projectNumber: string } {
  step('Preflight');
  out(`  project ${cfg.projectId}, region ${cfg.region}${dryRun ? ' (dry run: nothing is changed)' : ''}`);
  if (dryRun) return { projectNumber: '000000000000' };
  if (!hasGcloud()) {
    throw new Error('gcloud not found. Install the Google Cloud CLI (winget install Google.CloudSDK), then run `gcloud auth login` and `gcloud auth application-default login`.');
  }
  const account = run('gcloud', ['config', 'get-value', 'account']).stdout;
  ok(`gcloud account ${account || '(none: run gcloud auth login)'}`);
  const projectNumber = gcloud(['projects', 'describe', cfg.projectId, '--format=value(projectNumber)']).stdout;
  ok(`project number ${projectNumber}`);
  return { projectNumber };
}

function enableApis(): void {
  step('APIs');
  gcloud(['services', 'enable', ...cfg.apis]);
  ok(`${cfg.apis.length} APIs enabled`);
}

function artifactRegistry(): void {
  step('Artifact Registry (container images for Cloud Run)');
  const args = [cfg.artifactRepo, `--location=${cfg.region}`];
  if (exists(['artifacts', 'repositories', 'describe', ...args])) return skip(`repository ${cfg.artifactRepo} exists`);
  gcloud(['artifacts', 'repositories', 'create', ...args, '--repository-format=docker', '--description=Churn Preventer images']);
  ok(`repository ${cfg.artifactRepo}`);
}

function serviceAccounts(): void {
  step('Service accounts');
  const accounts: [string, string][] = [
    [cfg.serviceAccounts.collector, 'Churn Preventer collector'],
    [cfg.serviceAccounts.processor, 'Churn Preventer processor'],
    [cfg.serviceAccounts.clusterer, 'Churn Preventer clusterer'],
    [cfg.serviceAccounts.pubsubPush, 'Pub/Sub push to the processor and clusterer'],
  ];
  for (const [email, display] of accounts) {
    if (exists(['iam', 'service-accounts', 'describe', email])) {
      skip(`${email} exists`);
      continue;
    }
    gcloud(['iam', 'service-accounts', 'create', email.split('@')[0]!, `--display-name=${display}`]);
    ok(email);
  }
}

function firestore(): void {
  step('Firestore (session tails, processed markers, live issues)');
  const db = `--database=${cfg.platform.firestoreDatabase}`;
  if (exists(['firestore', 'databases', 'describe', db])) skip(`database ${cfg.platform.firestoreDatabase} exists`);
  else {
    gcloud(['firestore', 'databases', 'create', db, `--location=${cfg.region}`, '--type=firestore-native']);
    ok(`database ${cfg.platform.firestoreDatabase} in ${cfg.region}`);
  }
  for (const group of [TAILS_COLLECTION, PROCESSED_COLLECTION, CLUSTERED_COLLECTION]) {
    const r = gcloud(['firestore', 'fields', 'ttls', 'update', 'expires_at', `--collection-group=${group}`, '--enable-ttl', db, '--async', '--quiet'], { allowFail: true });
    if (r.ok) ok(`TTL on ${group}.expires_at`);
    else warn(`TTL on ${group}.expires_at: ${r.stderr.split('\n')[0]}`);
  }
  const index = gcloud(clustersIndexArgs(cfg, CLUSTERS_COLLECTION), { allowFail: true });
  if (index.ok) ok(`index on ${CLUSTERS_COLLECTION} (tenant_id, last_seen desc), building in the background`);
  else if (/ALREADY_EXISTS|already exists/i.test(index.stderr)) skip(`index on ${CLUSTERS_COLLECTION} exists`);
  else warn(`index on ${CLUSTERS_COLLECTION}: ${index.stderr.split('\n')[0]}`);
}

async function pubsub(): Promise<void> {
  step('Pub/Sub');
  const ps = new PubSub({ projectId: cfg.projectId });
  for (const name of [cfg.topics.eventsRaw, cfg.topics.signals, cfg.topics.eventsRawDlq, cfg.topics.signalsDlq]) {
    if (dryRun) {
      out(`  would ensure topic ${name}`);
      continue;
    }
    const [e] = await ps.topic(name).exists();
    if (e) skip(`topic ${name} exists`);
    else {
      await ps.createTopic(name);
      ok(`topic ${name}`);
    }
  }
  const spec = eventsRawSubscriptionSpec(cfg);
  if (dryRun) {
    out(`  would ensure subscription ${cfg.subscriptions.eventsRaw} (ordered, dead-letter ${cfg.topics.eventsRawDlq} after 10 attempts)`);
    out(`  would ensure subscription ${cfg.subscriptions.eventsRawDlq} (keeps dead letters 7 days)`);
    out(`  would ensure subscription ${cfg.subscriptions.signals} (dead-letter ${cfg.topics.signalsDlq} after 10 attempts)`);
    out(`  would ensure subscription ${cfg.subscriptions.signalsDlq} (keeps dead letters 7 days)`);
    return;
  }
  const sub = ps.subscription(cfg.subscriptions.eventsRaw);
  const [subExists] = await sub.exists();
  if (!subExists) {
    await ps.topic(cfg.topics.eventsRaw).createSubscription(cfg.subscriptions.eventsRaw, spec);
    ok(`subscription ${cfg.subscriptions.eventsRaw} (pull until the processor is deployed; deploy switches it to push)`);
  } else {
    const [meta] = await sub.getMetadata();
    if (!meta.enableMessageOrdering) warn(`${cfg.subscriptions.eventsRaw} exists without message ordering; ordering cannot be changed, recreate it`);
    else skip(`subscription ${cfg.subscriptions.eventsRaw} exists`);
  }
  const [signalsExists] = await ps.subscription(cfg.subscriptions.signals).exists();
  if (signalsExists) skip(`subscription ${cfg.subscriptions.signals} exists`);
  else {
    await ps.topic(cfg.topics.signals).createSubscription(cfg.subscriptions.signals, signalsSubscriptionSpec(cfg));
    ok(`subscription ${cfg.subscriptions.signals} (pull until the clusterer is deployed; deploy switches it to push)`);
  }
  for (const [dlqSub, dlqTopic] of [
    [cfg.subscriptions.eventsRawDlq, cfg.topics.eventsRawDlq],
    [cfg.subscriptions.signalsDlq, cfg.topics.signalsDlq],
  ] as const) {
    const [dlqExists] = await ps.subscription(dlqSub).exists();
    if (dlqExists) skip(`subscription ${dlqSub} exists`);
    else {
      await ps.topic(dlqTopic).createSubscription(dlqSub, { messageRetentionDuration: { seconds: 7 * 24 * 3600 } });
      ok(`subscription ${dlqSub}`);
    }
  }
}

async function bucket(): Promise<void> {
  step('Cloud Storage (raw chunks)');
  if (dryRun) {
    out(`  would ensure gs://${cfg.bucket} in ${cfg.region}: uniform access, public access prevented, delete raw/ after ${cfg.retentionDays} days`);
    return;
  }
  const storage = new Storage({ projectId: cfg.projectId });
  const b = storage.bucket(cfg.bucket);
  const [e] = await b.exists();
  if (!e) {
    await storage.createBucket(cfg.bucket, bucketSpec(cfg));
    ok(`gs://${cfg.bucket} (raw/ expires after ${cfg.retentionDays} days)`);
  } else {
    await b.setMetadata({ lifecycle: { rule: [lifecycleRule(cfg)] } });
    skip(`gs://${cfg.bucket} exists; retention rule set to ${cfg.retentionDays} days`);
  }
}

async function bigquery(): Promise<void> {
  step('BigQuery');
  const views = viewSpecs(cfg);
  if (dryRun) {
    out(`  would ensure dataset ${cfg.dataset} in ${cfg.region}`);
    for (const t of Object.values(BQ_TABLES)) out(`  would ensure table ${t.name} (partition DAY(${t.partitionField}), cluster ${t.clusterFields.join(', ')})`);
    for (const v of views) out(`  would ensure view ${v.name}`);
    out(`  would grant WRITER on ${cfg.dataset} to ${cfg.serviceAccounts.processor}`);
    return;
  }
  const bq = new BigQuery({ projectId: cfg.projectId, location: cfg.region });
  const ds = bq.dataset(cfg.dataset);
  const [dsExists] = await ds.exists();
  if (!dsExists) {
    await bq.createDataset(cfg.dataset, { location: cfg.region });
    ok(`dataset ${cfg.dataset}`);
  } else skip(`dataset ${cfg.dataset} exists`);

  for (const spec of Object.values(BQ_TABLES)) {
    const table = ds.table(spec.name);
    const [e] = await table.exists();
    if (!e) {
      await ds.createTable(spec.name, tableSpec(spec));
      ok(`table ${spec.name}`);
      continue;
    }
    // Existing tables: add new nullable columns (the only schema change BigQuery allows in place).
    const [meta] = await table.getMetadata();
    const have = new Set<string>((meta.schema?.fields ?? []).map((f: { name: string }) => f.name));
    const missing = spec.fields.filter((f) => !have.has(f.name));
    const required = missing.filter((f) => f.mode === 'REQUIRED');
    if (required.length > 0) warn(`${spec.name} lacks REQUIRED columns ${required.map((f) => f.name).join(', ')}; add them by migration`);
    const nullable = missing.filter((f) => f.mode === 'NULLABLE');
    if (nullable.length > 0) {
      await table.setMetadata({ schema: { fields: [...(meta.schema?.fields ?? []), ...nullable] } });
      ok(`table ${spec.name}: added ${nullable.map((f) => f.name).join(', ')}`);
    } else if (required.length === 0) skip(`table ${spec.name} is current`);
  }

  for (const v of views) {
    const table = ds.table(v.name);
    const [e] = await table.exists();
    if (e) {
      await table.setMetadata({ view: { query: v.query, useLegacySql: false } });
      skip(`view ${v.name} exists; query refreshed`);
    } else {
      await ds.createTable(v.name, { view: { query: v.query, useLegacySql: false } });
      ok(`view ${v.name}`);
    }
  }

  const [dsMeta] = await ds.getMetadata();
  const access: { role?: string; userByEmail?: string }[] = dsMeta.access ?? [];
  const email = cfg.serviceAccounts.processor;
  if (access.some((a) => a.role === 'WRITER' && a.userByEmail === email)) skip(`processor can write to ${cfg.dataset}`);
  else {
    await ds.setMetadata({ access: [...access, { role: 'WRITER', userByEmail: email }] });
    ok(`WRITER on ${cfg.dataset} for ${email}`);
  }
}

function upsertSecret(name: string, value: string): void {
  if (exists(['secrets', 'describe', name])) {
    const current = run('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, `--project=${cfg.projectId}`]).stdout;
    if (current === value) return skip(`secret ${name} is current`);
    gcloud(['secrets', 'versions', 'add', name, '--data-file=-'], { input: value });
    return ok(`secret ${name}: new version from .env`);
  }
  gcloud(['secrets', 'create', name, '--replication-policy=user-managed', `--locations=${cfg.region}`, '--data-file=-'], { input: value });
  ok(`secret ${name} from .env`);
}

function secrets(): void {
  step('Secret Manager');
  const siteKeys = process.env.SITE_KEYS;
  if (!siteKeys) throw new Error('SITE_KEYS is empty. Set it in .env, for example SITE_KEYS={"pk_test_yourkey":"demo"}');
  let normalized: string;
  try {
    normalized = JSON.stringify(JSON.parse(siteKeys));
  } catch {
    throw new Error('SITE_KEYS in .env is not valid JSON');
  }
  upsertSecret(cfg.secrets.siteKeys, normalized);
  const gemini = process.env.GOOGLE_API_KEY;
  if (gemini) upsertSecret(cfg.secrets.geminiApiKey, gemini);
  else skip(`${cfg.secrets.geminiApiKey}: GOOGLE_API_KEY not set (needed from Phase 3)`);
}

function iam(projectNumber: string): void {
  step('IAM (least privilege, per resource where possible)');
  for (const b of projectBindings(cfg)) {
    gcloud(['projects', 'add-iam-policy-binding', cfg.projectId, `--member=${b.member}`, `--role=${b.role}`, '--condition=None', '--quiet', '--format=none']);
    ok(`${b.role} -> ${b.member.split(':')[1]}`);
  }
  const agent = `service-${projectNumber}@gcp-sa-pubsub.iam.gserviceaccount.com`;
  for (const b of resourceBindings(cfg, agent)) {
    gcloud([...bindingArgs(b), '--format=none']);
    ok(`${b.role} on ${b.resource} -> ${b.member.split(':')[1]}`);
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  cfg = loadInfraConfig();
  const { projectNumber } = preflight();
  enableApis();
  artifactRegistry();
  serviceAccounts();
  firestore();
  await pubsub();
  await bucket();
  await bigquery();
  secrets();
  iam(projectNumber);

  step(dryRun ? 'Dry run complete' : 'Done');
  out(`  Next: pnpm deploy:collector && pnpm deploy:processor && pnpm deploy:clusterer`);
  out(`  Or run locally against GCP: set CP_MODE=gcp, PROCESSOR_PULL=true and CLUSTERER_PULL=true in .env, then pnpm dev`);
  out(`  Logs: ${logsExplorerUrl(cfg.projectId, serviceLogFilter(cfg.projectId))}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const hint = /default credentials|Could not load the default credentials/i.test(message)
    ? '\nHint: run `gcloud auth application-default login`, or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key file.'
    : '';
  process.stderr.write(`\ninfra:up failed: ${message}${hint}\n`);
  process.exit(1);
});
