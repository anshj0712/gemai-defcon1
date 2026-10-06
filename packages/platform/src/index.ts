import { join } from 'node:path';
import { BigQuery } from '@google-cloud/bigquery';
import { Firestore } from '@google-cloud/firestore';
import { PubSub } from '@google-cloud/pubsub';
import { Storage } from '@google-cloud/storage';
import type { Logger } from '@cp/logger';
import { GcsBlobStore, LocalBlobStore, type BlobStore } from './blob.js';
import type { PlatformConfig } from './config.js';
import { GcpPublisher, LocalPublisher, type Publisher } from './publisher.js';
import { FirestoreStateStore, LocalStateStore, type StateStore } from './state.js';
import { startPullSubscription, type PullHandler } from './subscriber.js';
import { BigQueryWarehouse, BigQueryWarehouseReader, LocalWarehouse, LocalWarehouseReader, type Warehouse, type WarehouseReader } from './warehouse.js';

export * from './blob.js';
export * from './config.js';
export * from './publisher.js';
export * from './state.js';
export * from './subscriber.js';
export * from './warehouse.js';

/** The I/O ports every service uses. Adapters are created on first use, so unused clients never start. */
export interface Platform {
  readonly config: PlatformConfig;
  readonly blob: BlobStore;
  readonly publisher: Publisher;
  readonly warehouse: Warehouse;
  readonly state: StateStore;
  /** Read queries for the API (tenant-scoped, cost-guarded). */
  readonly reader: WarehouseReader;
  /** gcp mode only: streaming pull from a subscription. */
  pull(subscription: string, handler: PullHandler): { close(): Promise<void> };
  close(): Promise<void>;
}

function lazy<T>(make: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= make());
}

export function createPlatform(config: PlatformConfig, logger: Logger): Platform {
  const dir = config.localDataDir;
  const projectId = config.projectId;
  const opts = projectId ? { projectId } : {};

  const pubsub = lazy(() => new PubSub(opts));
  const blob = lazy<BlobStore>(() =>
    config.mode === 'gcp'
      ? new GcsBlobStore(new Storage(opts), config.rawBucket)
      : new LocalBlobStore(join(dir, 'gcs'), config.rawBucket),
  );
  const publisher = lazy<Publisher>(() =>
    config.mode === 'gcp'
      ? new GcpPublisher(pubsub())
      : new LocalPublisher({ dir: join(dir, 'pubsub'), endpoints: config.localPushEndpoints, logger }),
  );
  const warehouse = lazy<Warehouse>(() =>
    config.mode === 'gcp'
      ? new BigQueryWarehouse(new BigQuery({ ...opts, location: config.region }), config.dataset)
      : new LocalWarehouse(join(dir, 'bq')),
  );
  const reader = lazy<WarehouseReader>(() =>
    config.mode === 'gcp'
      ? new BigQueryWarehouseReader(new BigQuery({ ...opts, location: config.region }), projectId!, config.dataset)
      : new LocalWarehouseReader(new LocalWarehouse(join(dir, 'bq'))),
  );
  const state = lazy<StateStore>(() =>
    config.mode === 'gcp'
      ? new FirestoreStateStore(new Firestore({ ...opts, databaseId: config.firestoreDatabase, ignoreUndefinedProperties: true }))
      : new LocalStateStore(join(dir, 'firestore')),
  );

  let publisherUsed = false;
  return {
    config,
    get blob() {
      return blob();
    },
    get publisher() {
      publisherUsed = true;
      return publisher();
    },
    get warehouse() {
      return warehouse();
    },
    get state() {
      return state();
    },
    get reader() {
      return reader();
    },
    pull(subscription, handler) {
      if (config.mode !== 'gcp') throw new Error('pull subscriptions need CP_MODE=gcp; local mode delivers by HTTP push');
      return startPullSubscription(pubsub(), subscription, handler, logger);
    },
    async close() {
      if (publisherUsed) await publisher().close();
    },
  };
}
