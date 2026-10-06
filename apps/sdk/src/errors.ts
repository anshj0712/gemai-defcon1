import { CUSTOM_TAGS, type ErrorPayloadShape } from '@cp/schema/tags';
import { stripQuery } from './route.js';

type Emit = (tag: string, payload: unknown) => void;

function frameOf(stack: string | undefined): string | null {
  if (!stack) return null;
  // First frame with a file location: "at fn (https://x/y/app.js?v=1:12:5)" or "fn@https://x/app.js:12:5".
  const m = /(?:\(|@|at\s)([^()\s]+?):(\d+):\d+\)?\s*$/m.exec(stack.split('\n').slice(1).join('\n') || stack);
  if (!m?.[1]) return null;
  const file = stripQuery(m[1]).split('/').pop() ?? m[1];
  return `${file}:${m[2]}`;
}

/**
 * Stable error signature: error type plus the first stack frame (file and line). The message is
 * never used: it can carry user data, and it varies per occurrence.
 */
export function errorSignature(err: unknown, fallback?: { filename?: string; lineno?: number }): string {
  const name = err instanceof Error ? err.name || 'Error' : typeof err === 'object' && err !== null ? 'Object' : typeof err;
  const frame = err instanceof Error ? frameOf(err.stack) : null;
  if (frame) return `${name} at ${frame}`;
  if (fallback?.filename) return `${name} at ${stripQuery(fallback.filename).split('/').pop()}:${fallback.lineno ?? 0}`;
  return name;
}

export function instrumentErrors(win: Window, emit: Emit): () => void {
  const onError = (e: ErrorEvent) => {
    const payload: ErrorPayloadShape = { kind: 'error', signature: errorSignature(e.error, { filename: e.filename, lineno: e.lineno }) };
    emit(CUSTOM_TAGS.error, payload);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    const payload: ErrorPayloadShape = { kind: 'unhandledrejection', signature: errorSignature(e.reason) };
    emit(CUSTOM_TAGS.error, payload);
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  return () => {
    win.removeEventListener('error', onError);
    win.removeEventListener('unhandledrejection', onRejection);
  };
}
