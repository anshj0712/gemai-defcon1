import type { StateStore } from '@cp/platform';
import type { SessionTail } from '@cp/schema';

/**
 * In-memory TTL cache in front of the state store, so a busy session does not cost a Firestore read
 * per chunk. Writes go through to the store, and only when the tail actually changed.
 */
export class TailCache {
  private readonly entries = new Map<string, { tail: SessionTail; json: string; expires: number }>();

  constructor(
    private readonly store: StateStore,
    private readonly opts: { ttlMs: number; max: number; storeTtlMs: number },
    private readonly now: () => number = Date.now,
  ) {}

  private key(tenantId: string, sessionId: string): string {
    return `${tenantId}/${sessionId}`;
  }

  async get(tenantId: string, sessionId: string): Promise<SessionTail | null> {
    const key = this.key(tenantId, sessionId);
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.tail;
    }
    const tail = await this.store.getTail(tenantId, sessionId);
    if (tail) this.remember(key, tail, JSON.stringify(tail));
    else this.entries.delete(key);
    return tail;
  }

  async put(tail: SessionTail): Promise<void> {
    const key = this.key(tail.tenant_id, tail.session_id);
    const json = JSON.stringify(tail);
    if (this.entries.get(key)?.json === json) return;
    await this.store.putTail(tail, this.opts.storeTtlMs);
    this.remember(key, tail, json);
  }

  private remember(key: string, tail: SessionTail, json: string): void {
    this.entries.delete(key);
    this.entries.set(key, { tail, json, expires: this.now() + this.opts.ttlMs });
    while (this.entries.size > this.opts.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
