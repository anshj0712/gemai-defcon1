import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { passwordMatches, registerPasswordGate, registerStatic } from '../src/gate.js';

const basic = (pw: string, user = 'me') => `Basic ${Buffer.from(`${user}:${pw}`).toString('base64')}`;

describe('password gate', () => {
  it('matches only the right password, any user name', () => {
    expect(passwordMatches(basic('s3cret-pass'), 's3cret-pass')).toBe(true);
    expect(passwordMatches(basic('s3cret-pass', ''), 's3cret-pass')).toBe(true);
    expect(passwordMatches(basic('wrong'), 's3cret-pass')).toBe(false);
    expect(passwordMatches(undefined, 's3cret-pass')).toBe(false);
    expect(passwordMatches('Bearer abc', 's3cret-pass')).toBe(false);
  });

  it('guards every route except /healthz', async () => {
    const app = Fastify();
    registerPasswordGate(app, 's3cret-pass');
    app.get('/healthz', async () => ({ ok: true }));
    app.get('/v1/findings', async () => ({ findings: [] }));
    expect((await app.inject('/healthz')).statusCode).toBe(200);
    const denied = await app.inject('/v1/findings');
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toContain('Basic');
    expect((await app.inject({ url: '/v1/findings', headers: { authorization: basic('s3cret-pass') } })).statusCode).toBe(200);
  });
});

describe('static dashboard', () => {
  it('serves files, falls back to index.html, and never leaves the folder or hides API 404s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-dash-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<h1>dash</h1>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'x');
    writeFileSync(join(tmpdir(), 'cp-secret.txt'), 'nope');
    const app = Fastify();
    app.get('/v1/ping', async () => ({ ok: true }));
    registerStatic(app, dir);
    expect((await app.inject('/')).body).toBe('<h1>dash</h1>');
    expect((await app.inject('/some/page')).body).toBe('<h1>dash</h1>');
    const js = await app.inject('/assets/app.js');
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.headers['cache-control']).toContain('immutable');
    expect((await app.inject('/..%2fcp-secret.txt')).body).toBe('<h1>dash</h1>');
    expect((await app.inject('/v1/nothing')).statusCode).toBe(404);
    expect((await app.inject('/v1/ping')).statusCode).toBe(200);
  });
});
