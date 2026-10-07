import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError } from "../errors/index.js";
import type { Admitted, Denied, DenialReason, RequestPermissionInput } from "./request-permission.js";

export interface QueueOptions {
  mode: "queue";
  /** Required: an unbounded wait has no safe default here, since two of the three queueable
   * denial reasons (budget_exceeded, circuit_open) have no guarantee of ever resolving — a
   * permanently exhausted budget or a circuit that never gets a successful probe would poll
   * forever without this. */
  queueTimeout: number;
}

/** Reasons that genuinely cannot be fixed by waiting — queuing on these would poll pointlessly
 * since nothing about the outcome changes with time. Denied immediately, even in queue mode. */
const NON_QUEUEABLE: ReadonlySet<DenialReason> = new Set(["unknown_agent"]);

const INITIAL_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 1_000;
const JITTER_RATIO = 0.2;

function nextBackoff(previousMs: number): number {
  const capped = Math.min(previousMs * 2, MAX_BACKOFF_MS);
  const jitter = capped * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(10, Math.round(capped + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateQueueOptions(options: unknown): asserts options is QueueOptions {
  if (options === null || typeof options !== "object") {
    throw new BrokerArgumentError("queue options must be an object");
  }
  const { mode, queueTimeout } = options as Record<string, unknown>;
  if (mode !== "queue") {
    throw new BrokerArgumentError(`mode must be 'queue', got ${String(mode)}`);
  }
  if (!Number.isSafeInteger(queueTimeout) || (queueTimeout as number) <= 0) {
    throw new BrokerArgumentError(`queueTimeout must be a positive integer (ms), got ${String(queueTimeout)}`);
  }
}

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
export async function requestPermissionQueued(
  config: ResolvedConfig,
  input: RequestPermissionInput,
  queueOptions: QueueOptions,
  attempt: (config: ResolvedConfig, input: RequestPermissionInput) => Promise<Admitted | Denied>,
): Promise<Admitted | Denied> {
  validateQueueOptions(queueOptions);

  const deadline = Date.now() + queueOptions.queueTimeout;
  let backoff = INITIAL_BACKOFF_MS;

  for (;;) {
    const result = await attempt(config, input);
    if (result.allowed) return result;
    if (NON_QUEUEABLE.has(result.reason)) return result; // unknown_agent: no point waiting

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { allowed: false, reason: "queue_timeout" };
    }

    backoff = nextBackoff(backoff);
    await sleep(Math.min(backoff, remaining));
  }
}