import type { BusinessEvent, IngestEnvelope } from '@cp/schema';
import type { Session } from './session.js';

export interface TransportDeps {
  /** Full ingest URL, e.g. http://localhost:8080/v1/ingest */
  url: string;
  fetch: typeof fetch;
  sendBeacon?: (url: string, data: Blob) => boolean;
  /** Gzip for normal flushes; omitted when CompressionStream is unavailable. */
  gzip?: (text: string) => Promise<Uint8Array>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export interface BatchMeta {
  siteKey: string;
  release: string;
  sdkVersion: string;
  sampleRate: number;
  page: () => { route: string; url_path: string };
}

type Envelope = Omit<IngestEnvelope, 'events'> & { events: unknown[] };

/** Native gzip via CompressionStream (no dependency). */
export async function gzipText(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Keepalive requests are capped at 64 KiB by browsers; stay under it. */
const KEEPALIVE_LIMIT = 60_000;

/**
 * Collects rrweb events into batches and ships them to the collector.
 * - A batch gets its seq when it is cut; retries resend the same seq (the collector stores it once).
 * - Sends are sequential, so batches leave in seq order.
 * - Bodies are text/plain (a CORS "simple" request, no preflight); the collector detects gzip.
 * - Failures never reach the host page. A batch that cannot be delivered is dropped; the
 *   processor tolerates the gap.
 */
export class Batcher {
  private events: unknown[] = [];
  private business: BusinessEvent[] = [];
  private batchStart: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: Session,
    private readonly meta: BatchMeta,
    private readonly deps: TransportDeps,
    private readonly maxEvents = 200,
  ) {
    this.batchStart = deps.now();
  }

  add(event: unknown): void {
    this.events.push(event);
    if (this.events.length >= this.maxEvents) void this.flush();
  }

  addBusiness(event: BusinessEvent): void {
    this.business.push(event);
  }

  /** Cut the current batch and send it (gzipped, retried). Resolves when every queued send settles. */
  flush(): Promise<void> {
    const envelope = this.cut();
    if (envelope) this.queue = this.queue.then(() => this.send(envelope));
    return this.queue;
  }

  /**
   * Last chance on pagehide: must be synchronous, so the batch goes uncompressed via sendBeacon
   * (falling back to a keepalive fetch).
   */
  flushBeacon(): void {
    const envelope = this.cut();
    if (!envelope) return;
    envelope.client_sent_at = this.deps.now();
    const body = JSON.stringify(envelope);
    const sent = this.deps.sendBeacon?.(this.deps.url, new Blob([body], { type: 'text/plain' })) ?? false;
    if (!sent) {
      void this.deps
        .fetch(this.deps.url, { method: 'POST', body, keepalive: body.length < KEEPALIVE_LIMIT, headers: { 'content-type': 'text/plain' } })
        .catch(() => undefined);
    }
  }

  private cut(): Envelope | null {
    if (this.events.length === 0 && this.business.length === 0) return null;
    const now = this.deps.now();
    const page = this.meta.page();
    const envelope: Envelope = {
      site_key: this.meta.siteKey,
      session_id: this.session.id,
      seq: this.session.nextSeq(),
      client_ts_start: Math.min(this.batchStart, now),
      client_ts_end: now,
      client_sent_at: now,
      sdk_version: this.meta.sdkVersion,
      release: this.meta.release,
      sample_rate: this.meta.sampleRate,
      page,
      events: this.events,
      business_events: this.business,
    };
    this.events = [];
    this.business = [];
    this.batchStart = now;
    return envelope;
  }

  private async send(envelope: Envelope): Promise<void> {
    const attempts = this.deps.maxAttempts ?? 4;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      envelope.client_sent_at = this.deps.now();
      const json = JSON.stringify(envelope);
      try {
        const body = this.deps.gzip ? await this.deps.gzip(json) : json;
        const size = typeof body === 'string' ? body.length : body.byteLength;
        const res = await this.deps.fetch(this.deps.url, {
          method: 'POST',
          body: body as BodyInit,
          keepalive: size < KEEPALIVE_LIMIT,
          headers: { 'content-type': 'text/plain' },
        });
        // Delivered, or rejected for a reason a retry cannot fix.
        if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) return;
      } catch {
        // Network error: retry below.
      }
      if (attempt < attempts) await this.deps.sleep(1000 * 2 ** (attempt - 1));
    }
  }
}
