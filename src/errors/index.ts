/** Thrown by createBroker when options are missing or inconsistent. Never thrown after startup. */
export class BrokerConfigError extends Error {
  override name = "BrokerConfigError";
}

/** Thrown when a per-call argument is malformed or forbidden (as opposed to a denial). */
export class BrokerArgumentError extends Error {
  override name = "BrokerArgumentError";
}