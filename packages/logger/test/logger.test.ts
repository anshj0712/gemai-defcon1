import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, logsExplorerUrl, pinoLevelToSeverity, serviceLogFilter, traceBindings } from '../src/index.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split('\n')) if (l.trim()) lines.push(JSON.parse(l) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('censors payload keys before anything is written', () => {
    const { lines, stream } = capture();
    const log = createLogger({ service: 'test', format: 'json', destination: stream, toCloud: false });
    log.info(
      {
        events: [{ type: 3, data: { text: 'secret' } }],
        body: 'raw body',
        site_key: 'pk_live_123456',
        req: { headers: { authorization: 'Bearer x', cookie: 'sid=1' } },
        evidence: { selector: 'button#ok', values: { total: 999 } },
        session_id: 's_ok_to_log',
      },
      'hello',
    );
    const line = lines[0]!;
    expect(JSON.stringify(line)).not.toContain('secret');
    expect(line.events).toBe('[redacted]');
    expect(line.body).toBe('[redacted]');
    expect(line.site_key).toBe('[redacted]');
    expect(line.req).not.toHaveProperty('headers');
    expect((line.evidence as Record<string, unknown>).values).toBe('[redacted]');
    expect((line.evidence as Record<string, unknown>).selector).toBe('button#ok');
    expect(line.session_id).toBe('s_ok_to_log');
    expect(line.service).toBe('test');
  });

  it('gcp format writes Cloud Logging structured JSON', () => {
    const { lines, stream } = capture();
    const log = createLogger({ service: 'collector', version: '1', format: 'gcp', projectId: 'p', destination: stream });
    log.warn({ events: ['x'] }, 'careful');
    const line = lines.at(-1)!;
    expect(line.severity).toBe('WARNING');
    expect(line.message).toBe('careful');
    expect(line.events).toBe('[redacted]');
    expect(line.serviceContext).toMatchObject({ service: 'collector', version: '1' });
  });
});

describe('error and request serializers', () => {
  // Shaped like a gaxios error from a Google client: it carries the request body and response.
  const clientError = () =>
    Object.assign(new Error('Request failed with status code 503'), {
      code: 503,
      config: { url: 'https://storage.googleapis.com/upload', data: 'SESSION-CONTENT-asha@example.com' },
      response: { data: 'RESPONSE-BODY' },
    });

  it.each(['json', 'gcp'] as const)('%s: logs an error without its request or response payload', (format) => {
    const { lines, stream } = capture();
    const log = createLogger({ service: 't', format, projectId: 'p', destination: stream, toCloud: false });
    log.error({ err: clientError() }, 'storing chunk failed');
    const text = JSON.stringify(lines.at(-1));
    expect(text).not.toContain('SESSION-CONTENT');
    expect(text).not.toContain('RESPONSE-BODY');
    expect(lines.at(-1)?.err).toMatchObject({ type: 'Error', message: 'Request failed with status code 503', code: 503 });
  });

  it('gcp: keeps the stack trace for Error Reporting', () => {
    const { lines, stream } = capture();
    createLogger({ service: 't', format: 'gcp', projectId: 'p', destination: stream, toCloud: false }).error({ err: clientError() }, 'x');
    expect(String(lines.at(-1)?.stack_trace)).toContain('Request failed with status code 503');
  });

  it('logs requests as method and path only', () => {
    const { lines, stream } = capture();
    createLogger({ service: 't', format: 'json', destination: stream, toCloud: false }).info(
      { req: { method: 'POST', url: '/v1/ingest?email=a@b.co', headers: { cookie: 'x' }, socket: { remoteAddress: '10.0.0.1' }, id: 'req-1' } },
      'r',
    );
    expect(lines[0]?.req).toEqual({ method: 'POST', path: '/v1/ingest', id: 'req-1' });
  });
});

describe('traceBindings', () => {
  it('reads W3C traceparent in gcp format', () => {
    const b = traceBindings({ traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, 'proj', 'gcp');
    expect(b['logging.googleapis.com/trace']).toBe('projects/proj/traces/0af7651916cd43dd8448eb211c80319c');
    expect(b['logging.googleapis.com/spanId']).toBe('b7ad6b7169203331');
  });

  it('falls back to X-Cloud-Trace-Context', () => {
    const b = traceBindings({ 'x-cloud-trace-context': '105445aa7843bc8bf206b12000100000/1;o=1' }, 'proj', 'gcp');
    expect(b['logging.googleapis.com/trace']).toBe('projects/proj/traces/105445aa7843bc8bf206b12000100000');
  });

  it('adds nothing to local output', () => {
    expect(traceBindings({ traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' }, 'proj', 'pretty')).toEqual({});
  });
});

describe('Cloud Logging helpers', () => {
  it('maps pino levels to severities', () => {
    expect([10, 20, 30, 40, 50, 60].map(pinoLevelToSeverity)).toEqual(['DEBUG', 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL']);
  });

  it('builds filters for Cloud Run and local runs', () => {
    expect(serviceLogFilter('p', { service: 'collector', source: 'cloud_run' })).toBe(
      'resource.type="cloud_run_revision" AND resource.labels.service_name="cp-collector"',
    );
    expect(serviceLogFilter('p', { source: 'local' })).toBe('logName="projects/p/logs/cp-local"');
    expect(serviceLogFilter('p')).toContain(' OR ');
    expect(logsExplorerUrl('my-proj', 'a="b"')).toBe('https://console.cloud.google.com/logs/query;query=a%3D%22b%22?project=my-proj');
  });
});
