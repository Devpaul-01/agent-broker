import type { ResolvedConfig } from "../config/index.js";
import type { Admitted, Denied, RequestPermissionInput } from "./request-permission.js";
export interface QueueOptions {
    mode: "queue";
    queueTimeout: number;
    /** Optional: lets the caller cancel a queued wait explicitly (e.g. the surrounding operation
     * was cancelled, the user navigated away) rather than being stuck until queueTimeout fires
     * regardless. Checked at the top of every poll iteration and also races the current sleep,
     * so an abort during a wait interrupts promptly rather than waiting out the full backoff. */
    signal?: AbortSignal;
}
export declare function validateQueueOptions(options: unknown): asserts options is QueueOptions;
/**
 * Polls requestPermission with exponential backoff (capped, jittered) until admitted,
 * queueTimeout elapses, or a non-queueable denial (currently only unknown_agent) is hit.
 *
 * This is a pure retry wrapper: every attempt goes through the exact same atomic admission
 * script as a non-queued call. Queue mode changes call cadence, never admission correctness —
 * no change to the Lua script was needed to build this.
 *
 * Node has no real blocking call here: this returns a Promise that resolves once a terminal
 * outcome is reached, implemented via awaited setTimeout-based polling. The event loop remains
 * free for other work in the same process during the wait.
 */
export declare function requestPermissionQueued(config: ResolvedConfig, input: RequestPermissionInput, queueOptions: QueueOptions, attempt: (config: ResolvedConfig, input: RequestPermissionInput) => Promise<Admitted | Denied>): Promise<Admitted | Denied>;
