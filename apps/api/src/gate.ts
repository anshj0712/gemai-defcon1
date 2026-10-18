import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';

export interface GateOptions {
  /** When set, every route except /healthz asks for this password (HTTP Basic: any user name). */
  password?: string;
  /** When set, the built dashboard is served from this folder (one deployed service for UI and API). */
  staticDir?: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Constant-time password check on an `Authorization: Basic ...` header. */
export function passwordMatches(header: string | undefined, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(digest(given), digest(password));
}

/** Register before the routes: it must see every request. */
export function registerPasswordGate(app: FastifyInstance, password: string): void {
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.split('?')[0] === '/healthz') return;
    if (passwordMatches(req.headers.authorization, password)) return;
    return reply.code(401).header('www-authenticate', 'Basic realm="Churn Preventer", charset="UTF-8"').send({ error: 'unauthorized' });
  });
}

/** Register after the routes: serves files from the dashboard build, and index.html for any other page. */
export function registerStatic(app: FastifyInstance, dir: string): void {
  const root = resolve(dir);
  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (req.method !== 'GET' || path.startsWith('/v1/') || path.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    const wanted = resolve(join(root, normalize(decodeURIComponent(path))));
    const inside = wanted === root || wanted.startsWith(root + sep);
    const file = inside && existsSync(wanted) && statSync(wanted).isFile() ? wanted : join(root, 'index.html');
    if (!existsSync(file)) return reply.code(404).send({ error: 'dashboard_not_built' });
    const hashed = file.includes(`${sep}assets${sep}`);
    return reply
      .header('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
      .header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      .send(readFileSync(file));
  });
}
