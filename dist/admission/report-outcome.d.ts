import type { ResolvedConfig } from "../config/index.js";
export interface ReportOutcomeInput {
    /**
     * null is a defined no-op: pass the reservationId you got back from a degraded admission
     * (requestPermission with onRedisUnavailable: 'allow' during a Redis outage), where no
     * reservation was ever created. Calling reportOutcome(null) resolves immediately with no
     * Redis call, rather than requiring callers to remember not to call it at all.
     */
    reservationId: string | null;
    success: boolean;
    actualCost?: number;
    /** Required when success is false: was this failure the target's fault and worth retrying
     * (timeout, 5xx), or not (a local validation error, a 4xx)? Only retryable failures count
     * toward the circuit breaker's sliding window — this is what lets requestPermission tell
     * "target is struggling" apart from "caller made a bad call" (Section 16). */
    retryable?: boolean;
}
export interface Resolved {
    allowed: true;
    costUnknown: boolean;
    /**
     * True when the refund could not be applied because the budget pool no longer existed
     * (deleted externally — the pool has no TTL of its own and nothing in the library deletes
     * it, so this means something outside the broker removed it). The reservation still
     * resolves normally: concurrency is released and it will not be reported on again.
     */
    poolMissing: boolean;
    /** True only for the reservationId: null no-op path — this admission never created a real
     * reservation because Redis was unreachable and onRedisUnavailable was 'allow'. */
    degraded?: boolean;
}
export type ReportDenialReason = "unknown_reservation" | "already_resolved";
export interface ReportDenial {
    allowed: false;
    reason: ReportDenialReason;
}
export declare function reportOutcome(config: ResolvedConfig, input: ReportOutcomeInput): Promise<Resolved | ReportDenial>;
