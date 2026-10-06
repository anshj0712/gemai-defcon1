/**
 * Keys censored before any log line is written, wherever it goes (console or Cloud Logging).
 * Defence in depth for AGENTS.md rule 8: code should never log payloads in the first place.
 */
export const REDACT_PATHS = [
  'events',
  '*.events',
  'business_events',
  '*.business_events',
  'body',
  '*.body',
  'payload',
  '*.payload',
  'envelope',
  '*.envelope',
  'site_key',
  '*.site_key',
  'evidence.values',
  '*.evidence.values',
  'headers.cookie',
  'headers.authorization',
  'req.headers.cookie',
  'req.headers.authorization',
];

export const REDACT_CENSOR = '[redacted]';
