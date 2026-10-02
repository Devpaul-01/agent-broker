/** Thrown by createBroker when options are missing or inconsistent. Never thrown after startup. */
export class BrokerConfigError extends Error {
  override name = "BrokerConfigError";
}

/** Thrown when a per-call argument is malformed or forbidden (as opposed to a denial). */
export class BrokerArgumentError extends Error {
  override name = "BrokerArgumentError";
}
/** Thrown for a genuine error (bad arguments, Redis/script failure) — never for an ordinary denial. */
export class BrokerError extends Error {
  override name = "BrokerError";
}