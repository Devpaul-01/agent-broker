import type { Redis } from "ioredis";
export interface BrokerHooks {
    onDecision?: (event: {
        agentId: string;
        target: string;
        result: unknown;
    }) => void;
    onOutcome?: (event: {
        reservationId: string | null;
        result: unknown;
    }) => void;
    onCircuitStateChange?: (event: {
        target: string;
        state: "open" | "closed";
    }) => void;
    onCleanup?: (event: {
        reservationId: string;
        target: string;
        budgetKey: string;
    }) => void;
}
export interface BrokerOptions {
    redis: Redis;
    maxDepth?: number;
    agentTtl?: number;
    defaultReservationTtl?: number;
    maxReservationTtl?: number;
    concurrencyLimit?: number;
    onRedisUnavailable?: "deny" | "allow";
    circuitBreaker?: CircuitBreakerOptions;
    hooks?: BrokerHooks;
}
export interface ResolvedConfig {
    readonly redis: Redis;
    readonly maxDepth: number;
    readonly agentTtl: number;
    readonly defaultReservationTtl: number;
    readonly maxReservationTtl: number;
    readonly concurrencyLimit: number;
    readonly onRedisUnavailable: "deny" | "allow";
    readonly circuitBreaker: Readonly<Required<CircuitBreakerOptions>>;
    readonly hooks: Readonly<BrokerHooks>;
}
export interface CircuitBreakerOptions {
    softThreshold?: number;
    hardThreshold?: number;
    windowMs?: number;
    probeRate?: number;
}
export declare function parseConfig(options: BrokerOptions): ResolvedConfig;
