import { hostname } from 'node:os';
import { Writable } from 'node:stream';
import { Logging, type Entry, type Log } from '@google-cloud/logging';

/** pino numeric level -> Cloud Logging severity. */
export function pinoLevelToSeverity(level: unknown): string {
  const n = typeof level === 'number' ? level : 30;
  if (n >= 60) return 'CRITICAL';
  if (n >= 50) return 'ERROR';
  if (n >= 40) return 'WARNING';
  if (n >= 30) return 'INFO';
  return 'DEBUG';
}

export interface CloudStreamOptions {
  projectId: string;
  logName: string;
  labels: Record<string, string>;
  flushMs?: number;
  maxBatch?: number;
}

const MAX_FAILURES = 5;

/**
 * A pino destination that ships each line to the Cloud Logging API in small batches. Used for
 * local runs (LOG_TO_CLOUD=true) so a developer's pipeline shows up in the GCP console. On Cloud
 * Run it is unnecessary: stdout is ingested directly.
 *
 * Never blocks the caller and never throws into the app: after repeated failures it disables
 * itself and says so once on stderr.
 */
export class CloudLoggingStream extends Writable {
  private readonly log: Log;
  private readonly flushMs: number;
  private readonly maxBatch: number;
  private readonly resource: { type: string; labels: Record<string, string> };
  private readonly labels: Record<string, string>;
  private buffer: Entry[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inflight: Promise<void> = Promise.resolve();
  private failures = 0;
  private disabled = false;

  constructor(opts: CloudStreamOptions) {
    super({ decodeStrings: false });
    this.log = new Logging({ projectId: opts.projectId }).log(opts.logName, { removeCircular: true });
    this.flushMs = opts.flushMs ?? 1000;
    this.maxBatch = opts.maxBatch ?? 50;
    this.resource = { type: 'global', labels: { project_id: opts.projectId } };
    this.labels = { host: hostname(), ...opts.labels };
  }

  override _write(chunk: unknown, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    if (!this.disabled) {
      try {
        this.enqueue(String(chunk));
      } catch {
        // A line we cannot parse is dropped here; it still reached the console stream.
      }
    }
    cb();
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.flush().then(() => cb(), cb);
  }

  private enqueue(line: string): void {
    const record = JSON.parse(line) as Record<string, unknown>;
    const { level, time, msg, pid: _pid, hostname: _host, service, ...rest } = record;
    const metadata = {
      severity: pinoLevelToSeverity(level),
      timestamp: new Date(typeof time === 'number' ? time : Date.now()),
      resource: this.resource,
      labels: { ...this.labels, ...(typeof service === 'string' ? { service } : {}) },
    };
    this.buffer.push(this.log.entry(metadata, { message: typeof msg === 'string' ? msg : '', service, ...rest }));
    if (this.buffer.length >= this.maxBatch) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushMs);
      this.timer.unref();
    }
  }

  /** Sends everything buffered so far. Safe to call at any time; resolves when the write settles. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.disabled || this.buffer.length === 0) return this.inflight;
    const batch = this.buffer;
    this.buffer = [];
    this.inflight = this.inflight.then(() =>
      this.log.write(batch, { partialSuccess: true }).then(
        () => {
          this.failures = 0;
        },
        (err: unknown) => {
          this.failures += 1;
          const reason = err instanceof Error ? err.message : String(err);
          if (this.failures >= MAX_FAILURES) {
            this.disabled = true;
            this.buffer = [];
            process.stderr.write(`[logger] Cloud Logging disabled after ${MAX_FAILURES} failed writes: ${reason}\n`);
          } else if (this.failures === 1) {
            process.stderr.write(`[logger] Cloud Logging write failed (will retry next batch): ${reason}\n`);
          }
        },
      ),
    );
    return this.inflight;
  }
}
