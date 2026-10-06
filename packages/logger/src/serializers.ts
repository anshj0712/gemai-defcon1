/**
 * Serializers that keep payloads out of logs. pino's default error serializer copies every enumerable
 * property, and Google client errors (gaxios) carry `config.data` (the request body: a raw chunk or
 * BigQuery rows) and `response.data`. So errors keep name, message, stack, and code only.
 */

const primitive = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

export function safeError(err: unknown, depth = 0): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: typeof err === 'string' ? err : 'non-Error value thrown' };
  const e = err as Error & { code?: unknown; status?: unknown; cause?: unknown };
  return {
    type: e.name,
    message: e.message,
    ...(e.stack ? { stack: e.stack } : {}),
    ...(primitive(e.code) ? { code: e.code } : {}),
    ...(primitive(e.status) ? { status: e.status } : {}),
    ...(e.cause !== undefined && depth < 3 ? { cause: safeError(e.cause, depth + 1) } : {}),
  };
}

/** Requests: method and path only. No query string, headers, body, or client IP. */
export function safeRequest(req: unknown): Record<string, unknown> {
  const r = (req ?? {}) as { method?: unknown; url?: unknown; id?: unknown };
  return {
    method: r.method,
    path: typeof r.url === 'string' ? r.url.split('?')[0] : undefined,
    ...(r.id !== undefined ? { id: r.id } : {}),
  };
}

export function safeResponse(res: unknown): Record<string, unknown> {
  return { statusCode: (res as { statusCode?: unknown } | null)?.statusCode };
}

export const SERIALIZERS = { err: safeError, error: safeError, req: safeRequest, res: safeResponse };
