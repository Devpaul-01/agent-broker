/**
 * Fires a hook without letting it affect the broker's own operation. A hook that throws,
 * returns a rejected promise, or simply misbehaves must never change requestPermission's or
 * reportOutcome's own result or latency — there is nowhere safe to surface a hook's own
 * failure without recursing into the same problem, so it is deliberately swallowed. Not
 * awaited from the caller's perspective: this fires the hook and returns immediately, letting
 * any async work the hook does happen in the background.
 */
export function fireHook<T>(hook: ((event: T) => void |Promise<unknown> ) | undefined, event: T): void {
  if (!hook) return;
  try {
    const result = hook(event);
    if (result instanceof Promise) {
      result.catch(() => {
        /* swallowed deliberately — see function doc comment */
      });
    }
  } catch {
    /* swallowed deliberately — see function doc comment */
  }
}