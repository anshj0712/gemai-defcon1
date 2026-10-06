import { spawnSync } from 'node:child_process';
import { logsExplorerUrl, serviceLogFilter } from '@cp/logger';
import { describe, loadInfraConfig, quoteForCmd, SERVICE_NAMES, type InfraConfig, type ServiceName } from '@cp/infra';
import { findRepoRoot, loadDotEnv } from '@cp/platform';

/**
 * `pnpm deploy:collector` / `deploy:processor` / `deploy:clusterer`: build, test, build the image with
 * Cloud Build, deploy to Cloud Run with its own service account, and (processor, clusterer) point
 * their subscription (events.raw.processor, signals.clusterer) at it as an authenticated push endpoint.
 *
 *   pnpm deploy:processor [-- --min 1] [--skip-tests] [--dry-run]
 *
 * Run `pnpm infra:up` once first. Minimum instances default to 0 (cheap); use --min 1 on demo day.
 */

const argv = process.argv.slice(2);
const service = argv[0] as ServiceName;
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = flag('dry-run');
const say = (s: string) => process.stdout.write(`${s}\n`);

if (!SERVICE_NAMES.includes(service)) {
  say(`usage: tsx scripts/deploy.ts <${SERVICE_NAMES.join('|')}> [--min N] [--skip-tests] [--dry-run]`);
  process.exit(2);
}

const root = findRepoRoot();
loadDotEnv(root);
const cfg: InfraConfig = loadInfraConfig();

function gcloud(args: string[]): string {
  const full = [...args, `--project=${cfg.projectId}`];
  say(`$ ${describe('gcloud', full)}`);
  if (dryRun) return '';
  // Long-running gcloud commands stream their own progress.
  const r = spawnSync(process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud', process.platform === 'win32' ? full.map(quoteForCmd) : full, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`gcloud ${args.slice(0, 3).join(' ')} failed`);
  return (r.stdout ?? '').trim();
}

function pnpm(script: string): void {
  say(`$ pnpm ${script}`);
  if (dryRun) return;
  const r = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [script], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`pnpm ${script} failed; not deploying a red build`);
}

/** yyyymmddhhmmss, plus the git commit when the repo has one. */
function imageTag(): string {
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const sha = git.status === 0 ? git.stdout.trim() : '';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return sha ? `${stamp}-${sha}` : stamp;
}

async function main(): Promise<void> {
  const name = cfg.services[service];
  const account = cfg.serviceAccounts[service];
  const minInstances = value('min') ?? process.env.CLOUD_RUN_MIN_INSTANCES ?? '0';
  const tag = imageTag();
  const image = `${cfg.region}-docker.pkg.dev/${cfg.projectId}/${cfg.artifactRepo}/${service}:${tag}`;

  say(`deploying ${service} -> Cloud Run ${name} in ${cfg.region} (project ${cfg.projectId})${dryRun ? ' [dry run]' : ''}`);
  if (!flag('skip-tests')) {
    pnpm('build');
    pnpm('test');
  }

  gcloud(['builds', 'submit', '--config=infra/cloudbuild.yaml', `--substitutions=_SERVICE=${service},_IMAGE=${image}`, '.']);

  const env = [
    'CP_MODE=gcp',
    `GCP_PROJECT_ID=${cfg.projectId}`,
    `GCP_REGION=${cfg.region}`,
    `RAW_BUCKET=${cfg.bucket}`,
    `BQ_DATASET=${cfg.dataset}`,
    `TOPIC_EVENTS_RAW=${cfg.topics.eventsRaw}`,
    `TOPIC_SIGNALS=${cfg.topics.signals}`,
    `SUB_EVENTS_RAW=${cfg.subscriptions.eventsRaw}`,
    `SUB_SIGNALS=${cfg.subscriptions.signals}`,
    `FIRESTORE_DATABASE=${cfg.platform.firestoreDatabase}`,
    `LOG_LEVEL=${process.env.LOG_LEVEL ?? 'info'}`,
    `SERVICE_VERSION=${tag}`,
  ];
  const common = [
    'run',
    'deploy',
    name,
    `--image=${image}`,
    `--region=${cfg.region}`,
    `--service-account=${account}`,
    `--set-env-vars=${env.join(',')}`,
    `--min-instances=${minInstances}`,
    '--max-instances=10',
    '--cpu=1',
    '--memory=512Mi',
    '--cpu-boost',
    '--port=8080',
    '--quiet',
  ];
  if (service === 'collector') {
    gcloud([...common, '--allow-unauthenticated', '--concurrency=80', '--timeout=30', `--set-secrets=SITE_KEYS=${cfg.secrets.siteKeys}:latest`]);
  } else {
    gcloud([...common, '--no-allow-unauthenticated', '--concurrency=20', '--timeout=120']);
  }

  const url = gcloud(['run', 'services', 'describe', name, `--region=${cfg.region}`, '--format=value(status.url)']) || `https://${name}-<hash>.a.run.app`;

  // Services fed by a Pub/Sub push subscription (private: only the push identity may invoke them).
  const pushSubscription: Partial<Record<ServiceName, string>> = { processor: cfg.subscriptions.eventsRaw, clusterer: cfg.subscriptions.signals };
  const subscription = pushSubscription[service];
  if (subscription) {
    gcloud(['run', 'services', 'add-iam-policy-binding', name, `--region=${cfg.region}`, `--member=serviceAccount:${cfg.serviceAccounts.pubsubPush}`, '--role=roles/run.invoker', '--quiet', '--format=none']);
    gcloud([
      'pubsub',
      'subscriptions',
      'modify-push-config',
      subscription,
      `--push-endpoint=${url}/pubsub/push`,
      `--push-auth-service-account=${cfg.serviceAccounts.pubsubPush}`,
      `--push-auth-token-audience=${url}`,
    ]);
    say(`${subscription} now pushes to ${url}/pubsub/push`);
  } else if (!dryRun) {
    const res = await fetch(`${url}/healthz`).catch((err: Error) => err);
    say(res instanceof Error ? `health check failed: ${res.message}` : `health check: HTTP ${res.status}`);
  }

  say('');
  say(`deployed ${name}: ${url}`);
  say(`logs (console): ${logsExplorerUrl(cfg.projectId, serviceLogFilter(cfg.projectId, { service, source: 'cloud_run' }))}`);
  say(`logs (terminal): pnpm logs:tail -- --service ${service}`);
}

main().catch((err: unknown) => {
  say(`deploy failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
