/** Thrown by createBroker when options are missing or inconsistent. Never thrown after startup. */
export class BrokerConfigError extends Error {
    name = "BrokerConfigError";
    constructor(message, options) {
        super(message, options);
    }
}
/** Thrown when a per-call argument is malformed or forbidden (as opposed to a denial). */
export class BrokerArgumentError extends Error {
    name = "BrokerArgumentError";
    constructor(message, options) {
        super(message, options);
    }
}
/** Thrown for a genuine error (bad arguments, Redis/script failure) — never for an ordinary denial. */
export class BrokerError extends Error {
    name = "BrokerError";
    constructor(message, options) {
        super(message, options);
    }
}
