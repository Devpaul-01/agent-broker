import type { Admitted, Denied } from "../../src/admission/request-permission.js";

export type Reserved = Admitted & { reservationId: string };

/** Narrows an admission to one that actually holds a reservation (not denied, not degraded). */
export function asReserved(result: Admitted | Denied): Reserved {
  if (!result.allowed) throw new Error(`setup: expected admission, got denial: ${result.reason}`);
  if (result.reservationId === null) throw new Error("setup: expected a real reservation, got a degraded admission");
  return result as Reserved;
}
