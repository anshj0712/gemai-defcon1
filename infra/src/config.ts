import { loadPlatformConfig, type PlatformConfig } from '@cp/platform';

/** Every resource name in one place. Region is shared by all of them (ARCHITECTURE.md section 8). */
export interface InfraConfig {
  platform: PlatformConfig;
  projectId: string;
  region: string;
  bucket: string;
  dataset: string;
  topics: { eventsRaw: string; signals: string; eventsRawDlq: string; signalsDlq: string };
  subscriptions: { eventsRaw: string; eventsRawDlq: string; signals: string; signalsDlq: string };
  retentionDays: number;
  artifactRepo: string;
  services: { collector: string; processor: string; clusterer: string };
  serviceAccounts: { collector: string; processor: string; clusterer: string; pubsubPush: string };
  secrets: { siteKeys: string; geminiApiKey: string };
  apis: string[];
}

export const SERVICE_NAMES = ['collector', 'processor', 'clusterer'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export function loadInfraConfig(env: NodeJS.ProcessEnv = process.env): InfraConfig {
  const platform = loadPlatformConfig({ ...env, CP_MODE: 'gcp' });
  const projectId = platform.projectId!;
  const sa = (name: string) => `${name}@${projectId}.iam.gserviceaccount.com`;
  const retention = Number(env.RAW_RETENTION_DAYS ?? 30);
  return {
    platform,
    projectId,
    region: platform.region,
    bucket: platform.rawBucket,
    dataset: platform.dataset,
    topics: {
      eventsRaw: platform.topics.eventsRaw,
      signals: platform.topics.signals,
      eventsRawDlq: `${platform.topics.eventsRaw}.dlq`,
      signalsDlq: `${platform.topics.signals}.dlq`,
    },
    subscriptions: {
      eventsRaw: platform.subscriptions.eventsRaw,
      eventsRawDlq: `${platform.topics.eventsRaw}.dlq.inspect`,
      signals: platform.subscriptions.signals,
      signalsDlq: `${platform.topics.signals}.dlq.inspect`,
    },
    retentionDays: Number.isFinite(retention) && retention > 0 ? retention : 30,
    artifactRepo: 'cp',
    services: { collector: 'cp-collector', processor: 'cp-processor', clusterer: 'cp-clusterer' },
    serviceAccounts: { collector: sa('cp-collector'), processor: sa('cp-processor'), clusterer: sa('cp-clusterer'), pubsubPush: sa('cp-pubsub-push') },
    secrets: { siteKeys: 'site-keys', geminiApiKey: 'gemini-api-key' },
    apis: [
      'run.googleapis.com',
      'pubsub.googleapis.com',
      'storage.googleapis.com',
      'bigquery.googleapis.com',
      'firestore.googleapis.com',
      'cloudbuild.googleapis.com',
      'artifactregistry.googleapis.com',
      'secretmanager.googleapis.com',
      'logging.googleapis.com',
      'iam.googleapis.com',
      'iamcredentials.googleapis.com',
      'cloudresourcemanager.googleapis.com',
    ],
  };
}
