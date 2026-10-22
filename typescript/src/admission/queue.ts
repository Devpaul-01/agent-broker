import type { ResolvedConfig } from "../config/index.js";
import { BrokerArgumentError } from "../errors/index.js";
import type { Admitted, Denied, DenialReason, RequestPermissionInput } from "./request-permission.js";

export interface QueueOptions {
  mode: "queue";
  queueTimeout: number;
  /** Optional: lets the caller cancel a queued wait explicitly (e.g. the surrounding operation
   * was cancelled, the user navigated away) rather than being stuck until queueTimeout fires
   * regardless. Checked at the top of every poll iteration and also races the current sleep,
   * so an abort during a wait interrupts promptly rather than waiting out the full backoff. */
  signal?: AbortSignal;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function validateQueueOptions(options: unknown): asserts options is QueueOptions {
  if (options === null || typeof options !== "object") {
    throw new BrokerArgumentError("queue options must be an object");
  }
  const { mode, queueTimeout, signal } = options as Record<string, unknown>;
  if (mode !== "queue") {
    throw new BrokerArgumentError(`mode must be 'queue', got ${String(mode)}`);
  }
  if (!Number.isSafeInteger(queueTimeout) || (queueTimeout as number) <= 0) {
    throw new BrokerArgumentError(`queueTimeout must be a positive integer (ms), got ${String(queueTimeout)}`);
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new BrokerArgumentError("signal must be an AbortSignal, if provided");
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

  if (queueOptions.signal?.aborted) {
    return { allowed: false, reason: "aborted" };
  }

  const deadline = Date.now() + queueOptions.queueTimeout;
  let backoff = INITIAL_BACKOFF_MS;

  for (;;) {
    const result = await attempt(config, input);
    if (result.allowed) return result;
    if (NON_QUEUEABLE.has(result.reason)) return result;

    if (queueOptions.signal?.aborted) {
      return { allowed: false, reason: "aborted" };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { allowed: false, reason: "queue_timeout" };
    }

    backoff = nextBackoff(backoff);
    try {
      await sleep(Math.min(backoff, remaining), queueOptions.signal);
    } catch {
      // sleep rejects only on abort (see sleep()'s implementation) — this is reached exactly
      // when the signal fires mid-wait, interrupting promptly rather than waiting out the
      // full backoff before the next poll's abort check would have caught it.
      return { allowed: false, reason: "aborted" };
    }
  }
}