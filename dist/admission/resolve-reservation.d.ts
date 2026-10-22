import type { ResolvedConfig } from "../config/index.js";
export interface ResolveOutcome {
    resolved: true;
    costUnknown: boolean;
    poolMissing: boolean;
    circuitClosed: boolean;
}
export type ResolveSkipReason = "unknown_reservation" | "already_resolved";
export interface ResolveSkipped {
    resolved: false;
    reason: ResolveSkipReason;
}
export interface ResolveParams {
    reservationId: string;
    budgetKey: string;
    target: string;
    success: boolean;
    actualCost?: number;
    retryable?: boolean;
    feedsCircuit: boolean;
    windowMs: number;
    /** Required even when feedsCircuit is false (cleanup): the script only reads this when it's
     * about to write a retryable failure into the window, which never happens for cleanup, but
     * the ARGV slot is always present so callers always supply the current configured value. */
    hardThreshold: number;
}
export declare function resolveReservation(config: ResolvedConfig, params: ResolveParams): Promise<ResolveOutcome | ResolveSkipped>;
