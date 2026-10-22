/** Thrown by createBroker when options are missing or inconsistent. Never thrown after startup. */
export declare class BrokerConfigError extends Error {
    name: string;
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** Thrown when a per-call argument is malformed or forbidden (as opposed to a denial). */
export declare class BrokerArgumentError extends Error {
    name: string;
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** Thrown for a genuine error (bad arguments, Redis/script failure) — never for an ordinary denial. */
export declare class BrokerError extends Error {
    name: string;
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
