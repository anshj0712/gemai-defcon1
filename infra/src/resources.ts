import type { TableMetadata } from '@google-cloud/bigquery';
import type { CreateSubscriptionOptions } from '@google-cloud/pubsub';
import type { CreateBucketRequest } from '@google-cloud/storage';
import { BQ_VIEWS, type BqTableSpec } from '@cp/schema';
import type { InfraConfig } from './config.js';

/** Pure resource specs, kept apart from the calls that apply them so they can be unit tested. */

export function bucketSpec(cfg: InfraConfig): CreateBucketRequest {
  return {
    location: cfg.region,
    storageClass: 'STANDARD',
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
    lifecycle: { rule: [lifecycleRule(cfg)] },
  };
}

/**
 * Raw chunks expire after the retention period (30 days by default, RAW_RETENTION_DAYS), and so do the
 * screenshots the agent renders from them (they show the same, already masked, session content).
 */
export function lifecycleRule(cfg: InfraConfig) {
  return { action: { type: 'Delete' as const }, condition: { age: cfg.retentionDays, matchesPrefix: ['raw/', 'screenshots/'] } };
}

export function eventsRawSubscriptionSpec(cfg: InfraConfig): CreateSubscriptionOptions {
  return {
    enableMessageOrdering: true,
    ackDeadlineSeconds: 60,
    messageRetentionDuration: { seconds: 7 * 24 * 3600 },
    retryPolicy: { minimumBackoff: { seconds: 10 }, maximumBackoff: { seconds: 600 } },
    deadLetterPolicy: { deadLetterTopic: `projects/${cfg.projectId}/topics/${cfg.topics.eventsRawDlq}`, maxDeliveryAttempts: 10 },
  };
}

/** signals -> clusterer. Unordered: the clusterer serializes per issue itself (transactions). */
export function signalsSubscriptionSpec(cfg: InfraConfig): CreateSubscriptionOptions {
  return {
    ackDeadlineSeconds: 30,
    messageRetentionDuration: { seconds: 7 * 24 * 3600 },
    retryPolicy: { minimumBackoff: { seconds: 10 }, maximumBackoff: { seconds: 600 } },
    deadLetterPolicy: { deadLetterTopic: `projects/${cfg.projectId}/topics/${cfg.topics.signalsDlq}`, maxDeliveryAttempts: 10 },
  };
}

/** The issues feed query (tenant_id ==, order by last_seen desc) needs this composite index. */
export function clustersIndexArgs(cfg: InfraConfig, collection: string): string[] {
  return firestoreIndexArgs(cfg, collection, 'last_seen');
}

/** The findings feed query (tenant_id ==, order by score desc) needs this composite index. */
export function findingsIndexArgs(cfg: InfraConfig, collection: string): string[] {
  return firestoreIndexArgs(cfg, collection, 'score');
}

function firestoreIndexArgs(cfg: InfraConfig, collection: string, orderField: string): string[] {
  return [
    'firestore',
    'indexes',
    'composite',
    'create',
    `--collection-group=${collection}`,
    '--query-scope=COLLECTION',
    '--field-config=field-path=tenant_id,order=ascending',
    `--field-config=field-path=${orderField},order=descending`,
    `--database=${cfg.platform.firestoreDatabase}`,
    '--async',
  ];
}

export function tableSpec(spec: BqTableSpec): TableMetadata {
  return {
    description: spec.description,
    schema: { fields: spec.fields.map((f) => ({ name: f.name, type: f.type, mode: f.mode, ...(f.description ? { description: f.description } : {}) })) },
    timePartitioning: { type: 'DAY', field: spec.partitionField },
    clustering: { fields: spec.clusterFields },
  };
}

export function viewSpecs(cfg: InfraConfig): { name: string; query: string }[] {
  const dataset = `${cfg.projectId}.${cfg.dataset}`;
  return Object.entries(BQ_VIEWS).map(([name, sql]) => ({ name, query: sql.replaceAll('{dataset}', dataset).trim() }));
}

/** Least-privilege bindings on individual resources (gcloud arguments after the resource name). */
export function resourceBindings(cfg: InfraConfig, pubsubAgent: string, opts: { geminiSecret?: boolean } = {}) {
  const sa = (email: string) => `serviceAccount:${email}`;
  const agent = sa(cfg.serviceAccounts.agent);
  return [
    { kind: 'topic', resource: cfg.topics.eventsRaw, member: sa(cfg.serviceAccounts.collector), role: 'roles/pubsub.publisher' },
    { kind: 'topic', resource: cfg.topics.signals, member: sa(cfg.serviceAccounts.processor), role: 'roles/pubsub.publisher' },
    { kind: 'subscription', resource: cfg.subscriptions.eventsRaw, member: sa(cfg.serviceAccounts.processor), role: 'roles/pubsub.subscriber' },
    { kind: 'subscription', resource: cfg.subscriptions.signals, member: sa(cfg.serviceAccounts.clusterer), role: 'roles/pubsub.subscriber' },
    // Dead-lettering is done by the Pub/Sub service agent.
    { kind: 'topic', resource: cfg.topics.eventsRawDlq, member: sa(pubsubAgent), role: 'roles/pubsub.publisher' },
    { kind: 'subscription', resource: cfg.subscriptions.eventsRaw, member: sa(pubsubAgent), role: 'roles/pubsub.subscriber' },
    { kind: 'topic', resource: cfg.topics.signalsDlq, member: sa(pubsubAgent), role: 'roles/pubsub.publisher' },
    { kind: 'subscription', resource: cfg.subscriptions.signals, member: sa(pubsubAgent), role: 'roles/pubsub.subscriber' },
    { kind: 'bucket', resource: `gs://${cfg.bucket}`, member: sa(cfg.serviceAccounts.collector), role: 'roles/storage.objectCreator' },
    { kind: 'bucket', resource: `gs://${cfg.bucket}`, member: sa(cfg.serviceAccounts.processor), role: 'roles/storage.objectViewer' },
    { kind: 'secret', resource: cfg.secrets.siteKeys, member: sa(cfg.serviceAccounts.collector), role: 'roles/secretmanager.secretAccessor' },
    // Lets Pub/Sub mint OIDC tokens as the push identity when calling the private processor and clusterer.
    { kind: 'service-account', resource: cfg.serviceAccounts.pubsubPush, member: sa(pubsubAgent), role: 'roles/iam.serviceAccountTokenCreator' },
    // The agent reads raw chunks to render the flagged moment and writes the screenshot next to them.
    { kind: 'bucket', resource: `gs://${cfg.bucket}`, member: agent, role: 'roles/storage.objectViewer' },
    { kind: 'bucket', resource: `gs://${cfg.bucket}`, member: agent, role: 'roles/storage.objectCreator' },
    // Only once the Gemini key exists (it is optional until Phase 3 runs against Gemini).
    ...(opts.geminiSecret ? [{ kind: 'secret' as const, resource: cfg.secrets.geminiApiKey, member: agent, role: 'roles/secretmanager.secretAccessor' as const }] : []),
  ] as const;
}

export function projectBindings(cfg: InfraConfig) {
  const sa = (email: string) => `serviceAccount:${email}`;
  return [
    { member: sa(cfg.serviceAccounts.collector), role: 'roles/logging.logWriter' },
    { member: sa(cfg.serviceAccounts.processor), role: 'roles/logging.logWriter' },
    { member: sa(cfg.serviceAccounts.processor), role: 'roles/bigquery.jobUser' },
    { member: sa(cfg.serviceAccounts.processor), role: 'roles/datastore.user' },
    { member: sa(cfg.serviceAccounts.clusterer), role: 'roles/logging.logWriter' },
    { member: sa(cfg.serviceAccounts.clusterer), role: 'roles/datastore.user' },
    { member: sa(cfg.serviceAccounts.agent), role: 'roles/logging.logWriter' },
    { member: sa(cfg.serviceAccounts.agent), role: 'roles/bigquery.jobUser' },
    { member: sa(cfg.serviceAccounts.agent), role: 'roles/datastore.user' },
  ];
}

export function bindingArgs(b: ReturnType<typeof resourceBindings>[number]): string[] {
  const common = [`--member=${b.member}`, `--role=${b.role}`, '--quiet'];
  switch (b.kind) {
    case 'topic':
      return ['pubsub', 'topics', 'add-iam-policy-binding', b.resource, ...common];
    case 'subscription':
      return ['pubsub', 'subscriptions', 'add-iam-policy-binding', b.resource, ...common];
    case 'bucket':
      return ['storage', 'buckets', 'add-iam-policy-binding', b.resource, ...common];
    case 'secret':
      return ['secrets', 'add-iam-policy-binding', b.resource, ...common];
    case 'service-account':
      return ['iam', 'service-accounts', 'add-iam-policy-binding', b.resource, ...common];
  }
}
