import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PubSub, Topic } from '@google-cloud/pubsub';
import type { Logger } from '@cp/logger';

export interface PublishOptions {
  /** Messages sharing a key are delivered in publish order. */
  orderingKey?: string;
  attributes?: Record<string, string>;
}

export interface Publisher {
  publish(topic: string, data: unknown, opts?: PublishOptions): Promise<string>;
  close(): Promise<void>;
}

export class GcpPublisher implements Publisher {
  private readonly topics = new Map<string, Topic>();

  constructor(private readonly pubsub: PubSub) {}

  private topic(name: string): Topic {
    let t = this.topics.get(name);
    if (!t) {
      t = this.pubsub.topic(name, { messageOrdering: true });
      this.topics.set(name, t);
    }
    return t;
  }

  async publish(topic: string, data: unknown, opts: PublishOptions = {}): Promise<string> {
    const t = this.topic(topic);
    try {
      return await t.publishMessage({
        json: data,
        ...(opts.orderingKey ? { orderingKey: opts.orderingKey } : {}),
        ...(opts.attributes ? { attributes: opts.attributes } : {}),
      });
    } catch (err) {
      // After a failure the client pauses the ordering key; resume so the caller's retry can go through.
      if (opts.orderingKey) t.resumePublishing(opts.orderingKey);
      throw err;
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.topics.values()].map((t) => t.flush()));
    await this.pubsub.close();
  }
}

export interface LocalPublisherOptions {
  /** Where messages are journaled, one `<topic>.jsonl` per topic. */
  dir: string;
  /** topic -> URL receiving Pub/Sub-style push requests. Topics without one are only journaled. */
  endpoints: Record<string, string>;
  logger: Logger;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * Stand-in for Pub/Sub in local mode. Journals every message, then delivers it asynchronously to
 * the topic's push endpoint in the same request format Pub/Sub push uses, retrying with backoff
 * (at-least-once). Messages sharing an ordering key are delivered one at a time, in order.
 */
export class LocalPublisher implements Publisher {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(private readonly opts: LocalPublisherOptions) {
    this.maxAttempts = opts.maxAttempts ?? 6;
    this.baseDelayMs = opts.baseDelayMs ?? 250;
  }

  async publish(topic: string, data: unknown, opts: PublishOptions = {}): Promise<string> {
    const messageId = randomUUID();
    const publishTime = new Date().toISOString();
    await mkdir(this.opts.dir, { recursive: true });
    const record = { messageId, publishTime, orderingKey: opts.orderingKey, attributes: opts.attributes, data };
    await appendFile(join(this.opts.dir, `${topic}.jsonl`), `${JSON.stringify(record)}\n`);

    const endpoint = this.opts.endpoints[topic];
    if (endpoint) {
      const key = `${topic}\u0000${opts.orderingKey ?? messageId}`;
      const prev = this.chains.get(key) ?? Promise.resolve();
      const next = prev.then(() => this.deliver(topic, endpoint, record));
      this.chains.set(key, next);
      void next.finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    }
    return messageId;
  }

  private async deliver(
    topic: string,
    endpoint: string,
    record: { messageId: string; publishTime: string; orderingKey?: string; attributes?: Record<string, string>; data: unknown },
  ): Promise<void> {
    const body = {
      message: {
        data: Buffer.from(JSON.stringify(record.data)).toString('base64'),
        attributes: record.attributes ?? {},
        messageId: record.messageId,
        publishTime: record.publishTime,
        ...(record.orderingKey ? { orderingKey: record.orderingKey } : {}),
      },
      subscription: `projects/local/subscriptions/${topic}.local`,
    };
    let lastError = '';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, deliveryAttempt: attempt }),
        });
        if (res.ok) return;
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = (err as Error).message;
      }
      if (attempt < this.maxAttempts) {
        this.opts.logger.warn({ topic, message_id: record.messageId, attempt, error: lastError }, 'local pubsub: push failed, retrying');
        await new Promise((r) => setTimeout(r, this.baseDelayMs * 2 ** (attempt - 1)));
      }
    }
    this.opts.logger.error(
      { topic, message_id: record.messageId, attempts: this.maxAttempts, error: lastError },
      'local pubsub: giving up on message; written to the dead-letter journal',
    );
    await appendFile(join(this.opts.dir, `${topic}.dlq.jsonl`), `${JSON.stringify(record)}\n`);
  }

  /** Waits (up to `timeoutMs`) for in-flight deliveries. */
  async close(timeoutMs = 5000): Promise<void> {
    const pending = Promise.allSettled([...this.chains.values()]);
    await Promise.race([pending, new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }
}
