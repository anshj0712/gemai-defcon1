/** Key-value storage for session identity; sessionStorage in the browser, a Map in tests or when blocked. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export function browserStore(): KeyValueStore {
  const memory = new Map<string, string>();
  const fallback: KeyValueStore = { get: (k) => memory.get(k) ?? null, set: (k, v) => void memory.set(k, v) };
  try {
    const s = window.sessionStorage;
    const probe = '__cp_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return { get: (k) => s.getItem(k), set: (k, v) => s.setItem(k, v) };
  } catch {
    return fallback;
  }
}

const SID = 'cp_sid';
const SEQ = 'cp_seq';
const SAMPLED = 'cp_sampled';

/** `s_` plus 20 random base-36 characters: matches the collector's safe-id rule. */
export function newSessionId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  return `s_${Array.from(random(20), (b) => alphabet[b % 36]).join('')}`;
}

/**
 * One browsing session: the id survives page loads within the tab, and batch numbers (`seq`) keep
 * counting across them, so the processor sees one contiguous sequence per session.
 */
export class Session {
  readonly id: string;

  constructor(private readonly store: KeyValueStore) {
    const existing = store.get(SID);
    this.id = existing && /^[A-Za-z0-9_-]{8,128}$/.test(existing) ? existing : newSessionId();
    if (this.id !== existing) {
      store.set(SID, this.id);
      store.set(SEQ, '0');
    }
  }

  /** Reserves the next batch number. Called once per batch, never per retry. */
  nextSeq(): number {
    const seq = Number(this.store.get(SEQ) ?? '0');
    const next = Number.isInteger(seq) && seq >= 0 ? seq : 0;
    this.store.set(SEQ, String(next + 1));
    return next;
  }

  /** Whether this session is recorded, decided once per session at `rate` (1 = always). */
  sampled(rate: number, random: () => number = Math.random): boolean {
    const decided = this.store.get(SAMPLED);
    if (decided === '1' || decided === '0') return decided === '1';
    const keep = random() < rate;
    this.store.set(SAMPLED, keep ? '1' : '0');
    return keep;
  }
}
