export interface Config {
  kswarmUrl: string;
  kswarmWsUrl: string;
  timeoutMs: number;
  pollIntervalMs: number;
  defaultProjectId: string | undefined;
}

export function loadConfig(): Config {
  const kswarmUrl = process.env.KSWARM_URL || 'http://127.0.0.1:4400';
  const kswarmWsUrl = process.env.KSWARM_WS_URL || kswarmUrl.replace(/^http/, 'ws') + '/ws';
  const timeoutMs = parseInt(process.env.KSWARM_TIMEOUT_MS || '600000', 10);
  const pollIntervalMs = parseInt(process.env.KSWARM_POLL_INTERVAL_MS || '3000', 10);
  const defaultProjectId = process.env.KSWARM_DEFAULT_PROJECT_ID || undefined;

  return { kswarmUrl, kswarmWsUrl, timeoutMs, pollIntervalMs, defaultProjectId };
}
