import { createGcpLoggingPinoConfig } from '@google-cloud/pino-logging-gcp-config';
import pino from 'pino';
import PinoPretty from 'pino-pretty';
import { CloudLoggingStream } from './cloud-stream.js';
import { LOCAL_LOG_NAME } from './links.js';
import { REDACT_CENSOR, REDACT_PATHS } from './redact.js';
import { SERIALIZERS } from './serializers.js';

export { CloudLoggingStream, pinoLevelToSeverity } from './cloud-stream.js';
export { CLOUD_RUN_PREFIX, LOCAL_LOG_NAME, logsExplorerUrl, serviceLogFilter, type LogSource } from './links.js';
export { REDACT_CENSOR, REDACT_PATHS } from './redact.js';
export { safeError, safeRequest, safeResponse } from './serializers.js';

export type Logger = pino.Logger;

/**
 * pretty: colored single-line output for a developer's terminal (default off Cloud Run).
 * json:   pino's default JSON lines.
 * gcp:    Cloud Logging structured JSON on stdout (default on Cloud Run, detected via K_SERVICE).
 */
export type LogFormat = 'pretty' | 'json' | 'gcp';

export function resolveLogFormat(env: NodeJS.ProcessEnv = process.env): LogFormat {
  const f = env.LOG_FORMAT;
  if (f === 'pretty' || f === 'json' || f === 'gcp') return f;
  return env.K_SERVICE ? 'gcp' : 'pretty';
}

const SERVICE_COLORS = ['cyan', 'magenta', 'yellow', 'green', 'blue'] as const;

function serviceColor(service: string): (typeof SERVICE_COLORS)[number] {
  if (service === 'collector') return 'cyan';
  if (service === 'processor') return 'magenta';
  let h = 0;
  for (const c of service) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return SERVICE_COLORS[h % SERVICE_COLORS.length] ?? 'cyan';
}

/**
 * The console formatter: `12:00:01.234 INFO [collector] chunk accepted {"seq":3,...}`.
 * Exported so `pnpm logs:tail` prints Cloud Logging entries exactly like local output.
 */
export function createPrettyStream(destination: NodeJS.WritableStream | number = 1): PinoPretty.PrettyStream {
  return PinoPretty({
    destination,
    sync: true,
    translateTime: 'SYS:HH:MM:ss.l',
    singleLine: true,
    ignore: 'pid,hostname,service,version',
    messageFormat: (log, messageKey, _level, { colors }) => {
      const service = typeof log.service === 'string' ? log.service : 'app';
      const tag = colors[serviceColor(service)](`[${service}]`);
      return `${tag} ${String(log[messageKey] ?? '')}`;
    },
  });
}

export interface CreateLoggerOptions {
  service: string;
  version?: string;
  level?: string;
  format?: LogFormat;
  /** Needed for trace correlation (gcp format) and for LOG_TO_CLOUD. */
  projectId?: string;
  /** Also ship to Cloud Logging from a non-Cloud-Run process. Defaults to LOG_TO_CLOUD=true. */
  toCloud?: boolean;
  /** Override the console destination (tests). */
  destination?: pino.DestinationStream;
}

const cloudStreams = new Set<CloudLoggingStream>();

export function createLogger(opts: CreateLoggerOptions): Logger {
  const env = process.env;
  const format = opts.format ?? resolveLogFormat(env);
  const level = opts.level ?? env.LOG_LEVEL ?? 'info';
  const projectId = opts.projectId ?? env.GCP_PROJECT_ID ?? env.GOOGLE_CLOUD_PROJECT;
  const version = opts.version ?? env.SERVICE_VERSION ?? env.K_REVISION ?? 'dev';
  const base: pino.LoggerOptions = {
    level,
    base: { service: opts.service },
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    serializers: SERIALIZERS,
  };

  if (format === 'gcp') {
    const config = createGcpLoggingPinoConfig(
      {
        serviceContext: { service: opts.service, version },
        ...(projectId ? { traceGoogleCloudProjectId: projectId } : {}),
        inihibitDiagnosticMessage: true,
      },
      base,
    );
    // stdout is already ingested by Cloud Run; shipping through the API as well would duplicate.
    return opts.destination ? pino(config, opts.destination) : pino(config);
  }

  const consoleStream: pino.DestinationStream =
    opts.destination ?? (format === 'pretty' ? createPrettyStream() : pino.destination({ dest: 1, sync: true }));
  const toCloud = opts.toCloud ?? env.LOG_TO_CLOUD === 'true';
  if (!toCloud) return pino(base, consoleStream);

  if (!projectId) {
    const logger = pino(base, consoleStream);
    logger.warn('LOG_TO_CLOUD=true but GCP_PROJECT_ID is not set; logging to the console only');
    return logger;
  }
  const cloud = new CloudLoggingStream({
    projectId,
    logName: LOCAL_LOG_NAME,
    labels: { service: opts.service, env: 'local' },
  });
  cloudStreams.add(cloud);
  return pino(
    base,
    pino.multistream([
      { level: level as pino.Level, stream: consoleStream },
      { level: level as pino.Level, stream: cloud },
    ]),
  );
}

/** Flush logs buffered for Cloud Logging. Call before the process exits. */
export async function flushLogs(): Promise<void> {
  await Promise.all([...cloudStreams].map((s) => s.flush()));
}

/**
 * Bindings that tie a request's log lines to its Cloud Trace span in Logs Explorer. Only meaningful
 * with the gcp format; returns {} otherwise so local lines stay short.
 */
export function traceBindings(
  headers: Record<string, string | string[] | undefined>,
  projectId: string | undefined,
  format: LogFormat = resolveLogFormat(),
): Record<string, string> {
  if (format !== 'gcp' || !projectId) return {};
  const header = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const traceparent = header('traceparent');
  const tp = traceparent ? /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec(traceparent) : null;
  if (tp) {
    return {
      'logging.googleapis.com/trace': `projects/${projectId}/traces/${tp[1]}`,
      'logging.googleapis.com/spanId': tp[2] ?? '',
    };
  }
  const cloud = header('x-cloud-trace-context');
  const traceId = cloud?.split('/')[0];
  if (traceId && /^[\da-f]{32}$/.test(traceId)) {
    return { 'logging.googleapis.com/trace': `projects/${projectId}/traces/${traceId}` };
  }
  return {};
}
