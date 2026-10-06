/** Log name used when local runs ship logs to Cloud Logging (LOG_TO_CLOUD=true). */
export const LOCAL_LOG_NAME = 'cp-local';
/** Cloud Run service names are `cp-<service>`. */
export const CLOUD_RUN_PREFIX = 'cp-';

export type LogSource = 'cloud_run' | 'local' | 'all';

/** Cloud Logging filter for our own service logs, optionally narrowed to one service. */
export function serviceLogFilter(projectId: string, opts: { service?: string; source?: LogSource } = {}): string {
  const source = opts.source ?? 'all';
  const cloudRun = opts.service
    ? `resource.type="cloud_run_revision" AND resource.labels.service_name="${CLOUD_RUN_PREFIX}${opts.service}"`
    : `resource.type="cloud_run_revision" AND resource.labels.service_name=~"^${CLOUD_RUN_PREFIX}"`;
  const local = opts.service
    ? `logName="projects/${projectId}/logs/${LOCAL_LOG_NAME}" AND labels.service="${opts.service}"`
    : `logName="projects/${projectId}/logs/${LOCAL_LOG_NAME}"`;
  if (source === 'cloud_run') return cloudRun;
  if (source === 'local') return local;
  return `(${cloudRun}) OR (${local})`;
}

/** Deep link into Logs Explorer for a filter. */
export function logsExplorerUrl(projectId: string, filter: string): string {
  return `https://console.cloud.google.com/logs/query;query=${encodeURIComponent(filter)}?project=${encodeURIComponent(projectId)}`;
}
