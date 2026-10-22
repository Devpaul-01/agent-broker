import type { ResolvedConfig } from "../config/index.js";
export interface RequestPermissionInput {
    agentId: string;
    target: string;
    estimatedCost: number;
    ttl?: number;
}
export interface Admitted {
    allowed: true;
    reservationId: string | null;
    retryAfter?: number;
    /** True only when this admission bypassed all coordination because Redis was unreachable
     * and onRedisUnavailable is 'allow'. budget, concurrency, and circuit state were neither
     * checked nor updated. reservationId is null in this case — see reportOutcome's handling
     * of a null reservationId, which is a defined, safe no-op specifically for this case. */
    degraded?: boolean;
}
export type DenialReason = "unknown_agent" | "aborted" | "budget_exceeded" | "concurrency_exceeded" | "circuit_open" | "redis_unavailable" | "queue_timeout";
export interface Denied {
    allowed: false;
    reason: DenialReason;
}
export declare function requestPermission(config: ResolvedConfig, input: RequestPermissionInput): Promise<Admitted | Denied>;
