/**
 * Narrow detection of "Redis is genuinely unreachable" versus any other thrown error. Only
 * connection-level failures qualify — a script bug, a malformed reply, or a validation error
 * must never be caught here, or onRedisUnavailable's fallback path would silently hide real
 * bugs behind the same handling meant for infrastructure failure.
 */
const CONNECTION_ERROR_PATTERNS = [
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "Connection is closed",
  "Stream isn't writeable",
] as const;

export function isRedisUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return CONNECTION_ERROR_PATTERNS.some((pattern) => error.message.includes(pattern));
}