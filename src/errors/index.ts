/** Thrown by createBroker when options are missing or inconsistent. Never thrown after startup. */
export class BrokerConfigError extends Error {
  override name = "BrokerConfigError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Thrown when a per-call argument is malformed or forbidden (as opposed to a denial). */
export class BrokerArgumentError extends Error {
  override name = "BrokerArgumentError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Thrown for a genuine error (bad arguments, Redis/script failure) — never for an ordinary denial. */
export class BrokerError extends Error {
  override name = "BrokerError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}