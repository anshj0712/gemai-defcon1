import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Storage } from '@google-cloud/storage';

/** Immutable object storage for raw chunks (Cloud Storage, or a folder in local mode). */
export interface BlobStore {
  uriFor(path: string): string;
  /** Writes only if nothing exists at `path`. `created` is false when an earlier write won. */
  putIfAbsent(path: string, data: Buffer, contentType: string): Promise<{ uri: string; created: boolean }>;
  get(uri: string): Promise<Buffer>;
}

function assertSafePath(path: string): void {
  if (path.startsWith('/') || path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe object path: ${path}`);
  }
}

function parseUri(uri: string, scheme: string): { bucket: string; path: string } {
  const m = new RegExp(`^${scheme}://([^/]+)/(.+)$`).exec(uri);
  if (!m?.[1] || !m[2]) throw new Error(`expected a ${scheme}:// URI, got ${uri}`);
  assertSafePath(m[2]);
  return { bucket: m[1], path: m[2] };
}

export class GcsBlobStore implements BlobStore {
  constructor(
    private readonly storage: Storage,
    private readonly bucket: string,
  ) {}

  uriFor(path: string): string {
    return `gs://${this.bucket}/${path}`;
  }

  async putIfAbsent(path: string, data: Buffer, contentType: string): Promise<{ uri: string; created: boolean }> {
    assertSafePath(path);
    const uri = this.uriFor(path);
    try {
      // ifGenerationMatch: 0 means "only if the object does not exist", which also makes retries safe.
      await this.storage
        .bucket(this.bucket)
        .file(path)
        .save(data, { resumable: false, contentType, preconditionOpts: { ifGenerationMatch: 0 } });
      return { uri, created: true };
    } catch (err) {
      if ((err as { code?: number }).code === 412) return { uri, created: false };
      throw err;
    }
  }

  async get(uri: string): Promise<Buffer> {
    const { bucket, path } = parseUri(uri, 'gs');
    const [data] = await this.storage.bucket(bucket).file(path).download();
    return data;
  }
}

/** local://bucket/path, stored under `<root>/<bucket>/<path>`. */
export class LocalBlobStore implements BlobStore {
  constructor(
    private readonly root: string,
    private readonly bucket: string,
  ) {}

  uriFor(path: string): string {
    return `local://${this.bucket}/${path}`;
  }

  private file(bucket: string, path: string): string {
    return join(this.root, bucket, ...path.split('/'));
  }

  async putIfAbsent(path: string, data: Buffer, _contentType?: string): Promise<{ uri: string; created: boolean }> {
    assertSafePath(path);
    const file = this.file(this.bucket, path);
    await mkdir(dirname(file), { recursive: true });
    try {
      await writeFile(file, data, { flag: 'wx' });
      return { uri: this.uriFor(path), created: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { uri: this.uriFor(path), created: false };
      throw err;
    }
  }

  async get(uri: string): Promise<Buffer> {
    const { bucket, path } = parseUri(uri, 'local');
    return readFile(this.file(bucket, path));
  }
}
