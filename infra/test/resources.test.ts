import { describe, expect, it } from 'vitest';
import { BQ_TABLES } from '@cp/schema';
import { loadInfraConfig } from '../src/config.js';
import { describe as describeCmd, quoteForCmd } from '../src/gcloud.js';
import { bindingArgs, bucketSpec, clustersIndexArgs, eventsRawSubscriptionSpec, findingsIndexArgs, projectBindings, resourceBindings, signalsSubscriptionSpec, tableSpec, viewSpecs } from '../src/resources.js';

const cfg = loadInfraConfig({ GCP_PROJECT_ID: 'cp-test-proj', RAW_RETENTION_DAYS: '14' });

describe('infra config', () => {
  it('derives every name from the project and keeps one region', () => {
    expect(cfg).toMatchObject({
      projectId: 'cp-test-proj',
      region: 'asia-south1',
      bucket: 'cp-test-proj-cp-raw',
      dataset: 'churn_preventer',
      topics: { eventsRaw: 'events.raw', signals: 'signals', eventsRawDlq: 'events.raw.dlq', signalsDlq: 'signals.dlq' },
      subscriptions: { eventsRaw: 'events.raw.processor', signals: 'signals.clusterer', signalsDlq: 'signals.dlq.inspect' },
      services: { clusterer: 'cp-clusterer' },
      retentionDays: 14,
      serviceAccounts: { collector: 'cp-collector@cp-test-proj.iam.gserviceaccount.com' },
    });
  });

  it('requires a project id', () => {
    expect(() => loadInfraConfig({})).toThrow(/GCP_PROJECT_ID/);
  });
});

describe('resource specs', () => {
  it('bucket: regional, private, raw chunks expire', () => {
    expect(bucketSpec(cfg)).toMatchObject({
      location: 'asia-south1',
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
      lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 14, matchesPrefix: ['raw/', 'screenshots/'] } }] },
    });
  });

  it('events.raw subscription: ordered, retried with backoff, dead-lettered', () => {
    expect(eventsRawSubscriptionSpec(cfg)).toMatchObject({
      enableMessageOrdering: true,
      deadLetterPolicy: { deadLetterTopic: 'projects/cp-test-proj/topics/events.raw.dlq', maxDeliveryAttempts: 10 },
      retryPolicy: { minimumBackoff: { seconds: 10 } },
    });
  });

  it('signals subscription: unordered, retried with backoff, dead-lettered', () => {
    const spec = signalsSubscriptionSpec(cfg);
    expect(spec).toMatchObject({
      deadLetterPolicy: { deadLetterTopic: 'projects/cp-test-proj/topics/signals.dlq', maxDeliveryAttempts: 10 },
      retryPolicy: { minimumBackoff: { seconds: 10 } },
    });
    expect(spec.enableMessageOrdering).toBeUndefined();
  });

  it('clusters index: tenant then most recent first, for the issues feed', () => {
    expect(clustersIndexArgs(cfg, 'clusters')).toEqual([
      'firestore',
      'indexes',
      'composite',
      'create',
      '--collection-group=clusters',
      '--query-scope=COLLECTION',
      '--field-config=field-path=tenant_id,order=ascending',
      '--field-config=field-path=last_seen,order=descending',
      '--database=(default)',
      '--async',
    ]);
  });

  it('tables: partitioned by day on event time, clustered by tenant first', () => {
    const t = tableSpec(BQ_TABLES.signals);
    expect(t.timePartitioning).toEqual({ type: 'DAY', field: 'event_time' });
    expect(t.clustering).toEqual({ fields: ['tenant_id', 'session_id'] });
    expect((t.schema as { fields: { name: string }[] }).fields.map((f) => f.name)).toEqual(BQ_TABLES.signals.fields.map((f) => f.name));
  });

  it('views point at the fully qualified dataset', () => {
    const views = viewSpecs(cfg);
    expect(views.map((v) => v.name)).toEqual(['findings_versions', 'signals_dedup']);
    for (const v of views) {
      expect(v.query).toContain('`cp-test-proj.churn_preventer.');
      expect(v.query).not.toContain('{dataset}');
    }
  });
});

describe('IAM', () => {
  const agent = 'service-123@gcp-sa-pubsub.iam.gserviceaccount.com';

  it('grants the collector only what ingest needs', () => {
    const roles = resourceBindings(cfg, agent)
      .filter((b) => b.member.includes('cp-collector'))
      .map((b) => `${b.role} ${b.resource}`);
    expect(roles.sort()).toEqual(['roles/pubsub.publisher events.raw', 'roles/secretmanager.secretAccessor site-keys', 'roles/storage.objectCreator gs://cp-test-proj-cp-raw'].sort());
    expect(projectBindings(cfg).filter((b) => b.member.includes('cp-collector')).map((b) => b.role)).toEqual(['roles/logging.logWriter']);
  });

  it('lets the Pub/Sub agent dead-letter both subscriptions and mint push tokens', () => {
    const agentRoles = resourceBindings(cfg, agent)
      .filter((b) => b.member.endsWith(agent))
      .map((b) => `${b.role} ${b.resource}`);
    expect(agentRoles.sort()).toEqual(
      [
        'roles/iam.serviceAccountTokenCreator cp-pubsub-push@cp-test-proj.iam.gserviceaccount.com',
        'roles/pubsub.publisher events.raw.dlq',
        'roles/pubsub.publisher signals.dlq',
        'roles/pubsub.subscriber events.raw.processor',
        'roles/pubsub.subscriber signals.clusterer',
      ].sort(),
    );
  });

  it('grants the clusterer only its subscription, Firestore, and logging', () => {
    const roles = resourceBindings(cfg, agent)
      .filter((b) => b.member.includes('cp-clusterer'))
      .map((b) => `${b.role} ${b.resource}`);
    expect(roles).toEqual(['roles/pubsub.subscriber signals.clusterer']);
    expect(projectBindings(cfg).filter((b) => b.member.includes('cp-clusterer')).map((b) => b.role).sort()).toEqual(['roles/datastore.user', 'roles/logging.logWriter']);
  });

  it('builds gcloud arguments per resource kind', () => {
    const [topicBinding] = resourceBindings(cfg, agent);
    expect(bindingArgs(topicBinding!)).toEqual([
      'pubsub',
      'topics',
      'add-iam-policy-binding',
      'events.raw',
      '--member=serviceAccount:cp-collector@cp-test-proj.iam.gserviceaccount.com',
      '--role=roles/pubsub.publisher',
      '--quiet',
    ]);
  });
});

describe('agent service IAM', () => {
  const pubsubAgent = 'service-123@gcp-sa-pubsub.iam.gserviceaccount.com';
  const agentRoles = (geminiSecret: boolean) =>
    resourceBindings(cfg, pubsubAgent, { geminiSecret })
      .filter((b) => b.member.includes('cp-agent'))
      .map((b) => `${b.role} ${b.resource}`)
      .sort();

  it('reads raw chunks, writes screenshots, publishes re-scanned signals, and reads the Gemini key only once it exists', () => {
    expect(agentRoles(false)).toEqual(['roles/pubsub.publisher signals', 'roles/storage.objectCreator gs://cp-test-proj-cp-raw', 'roles/storage.objectViewer gs://cp-test-proj-cp-raw']);
    expect(agentRoles(true)).toContain('roles/secretmanager.secretAccessor gemini-api-key');
    expect(projectBindings(cfg).filter((b) => b.member.includes('cp-agent')).map((b) => b.role).sort()).toEqual(['roles/bigquery.jobUser', 'roles/datastore.user', 'roles/logging.logWriter']);
  });

  it('indexes findings by tenant, highest score first', () => {
    expect(findingsIndexArgs(cfg, 'findings')).toContain('--field-config=field-path=score,order=descending');
  });
});

describe('cmd.exe quoting', () => {
  it.each([
    ['--format=value(projectNumber)', '"--format=value(projectNumber)"'],
    ['--database=(default)', '"--database=(default)"'],
    ['--display-name=Churn Preventer collector', '"--display-name=Churn Preventer collector"'],
    ['events.raw', 'events.raw'],
  ])('%s', (arg, expected) => {
    expect(quoteForCmd(arg)).toBe(expected);
  });

  it('prints commands readably', () => {
    expect(describeCmd('gcloud', ['services', 'enable', 'run.googleapis.com'])).toBe('gcloud services enable run.googleapis.com');
  });
});
