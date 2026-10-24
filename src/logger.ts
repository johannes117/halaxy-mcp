/**
 * stderr-only logger. stdout is reserved for the MCP protocol.
 *
 * Debug logging is off unless HALAXY_MCP_DEBUG=1. Even then, callers must only pass
 * non-PHI metadata (method, path template, status, timings). Bodies and headers are
 * never logged; `redact` is a last line of defence for anything that slips through.
 */

const BEARER = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_KV =
  /("?(?:client_secret|access_token|refresh_token|authorization)"?\s*[:=]\s*)"?[^",\s}]+"?/gi;

export function redact(text: string): string {
  return text.replace(BEARER, 'Bearer [REDACTED]').replace(SECRET_KV, '$1[REDACTED]');
}

export function debugEnabled(): boolean {
  return process.env.HALAXY_MCP_DEBUG === '1';
}

type Sink = (line: string) => void;
let sink: Sink = (line) => process.stderr.write(line + '\n');

/** Test hook: capture log output. */
export function setLogSink(next: Sink | undefined): void {
  sink = next ?? ((line) => process.stderr.write(line + '\n'));
}

function emit(level: string, message: string, meta?: Record<string, unknown>): void {
  const parts = [`[halaxy-mcp] ${level}: ${message}`];
  if (meta && Object.keys(meta).length > 0) parts.push(JSON.stringify(meta));
  sink(redact(parts.join(' ')));
}

export const log = {
  debug(message: string, meta?: Record<string, unknown>): void {
    if (debugEnabled()) emit('debug', message, meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    emit('info', message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    emit('warn', message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    emit('error', message, meta);
  },
};
