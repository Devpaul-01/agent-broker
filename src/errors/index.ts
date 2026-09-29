/** Thrown by createBroker when options are missing or inconsistent. Never thrown after startup. */
export class BrokerConfigError extends Error {
  override name = "BrokerConfigError";
}