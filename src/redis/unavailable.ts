/**
 * Narrow detection of "Redis is genuinely unreachable" versus any other thrown error. Only
 * connection-level failures qualify — a script bug, a malformed reply, or a validation error
 * must never be caught here, or onRedisUnavailable's fallback path would silently hide real
 * bugs behind the same handling meant for infrastructure failure.
 *
 * ioredis does not export a single "ConnectionError" class to check with instanceof (verified
 * against its actual published exports before writing this — it exports MaxRetriesPerRequestError
 * and relies on the separate redis-errors package for lower-level typing, none of which map
 * cleanly onto "unreachable" as one type). Detection here is therefore: (1) MaxRetriesPerRequestError
 * by name, since that's ioredis's own real class for "gave up trying to reach Redis"; (2) Node's
 * own socket-level error .code (ECONNREFUSED, ETIMEDOUT, ENOTFOUND), which is more stable across
 * ioredis versions than matching message wording, since .code comes from Node's net/dns modules
 * directly; (3) message substring matching as a fallback for errors that don't carry a .code,
 * covering ioredis's own closed-connection/offline-queue wording.
 */
const CONNECTION_ERROR_CODES = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET"] as const;
const CONNECTION_ERROR_MESSAGE_PATTERNS = [
  "Connection is closed",
  "Stream isn't writeable",
  "Reached the max retries per request limit",
] as const;

export function isRedisUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "MaxRetriesPerRequestError") return true;

  const code = (error as NodeJS.ErrnoException).code;
  if (code !== undefined && (CONNECTION_ERROR_CODES as readonly string[]).includes(code)) return true;

  // Some errors (e.g. a raw "connect ECONNREFUSED 127.0.0.1:6379" Error constructed without a
  // .code property, as our own unit tests do) carry the code only in the message text. Checking
  // the codes as substrings here catches those without relying on .code being set.
  if ((CONNECTION_ERROR_CODES as readonly string[]).some((code) => error.message.includes(code))) return true;

  return CONNECTION_ERROR_MESSAGE_PATTERNS.some((pattern) => error.message.includes(pattern));
}