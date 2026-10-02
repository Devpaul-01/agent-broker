/**
 * Every Redis key the library touches is built here, and nowhere else.
 *
 * Caller-supplied strings (target, budgetKey) are length-prefixed so that keys built from
 * several of them cannot be re-split ambiguously. Targets contain colons by convention
 * ("groq:llama-3.3-70b"), so a plain ":" separator would map ("a:b","c") and ("a","b:c")
 * to the same key and silently merge two unrelated concurrency counters (Invariant 13).
 * Broker-issued IDs (agent, reservation) are UUIDs and safe to use raw.
 */
const seg = (value: string): string => `${value.length}:${value}`;
export const keys = {
  agent: (agentId: string) => `agent:${agentId}`,
  budget: (budgetKey: string) => `budget:${seg(budgetKey)}`,
  reservation: (reservationId: string) => `reservation:${reservationId}`,
  // Logical expiry index, separate from the reservation hash's own Redis-level TTL.
  // One sorted set total (not per-reservation): member = reservationId, score = expiresAt (ms).
  // Lets lazy cleanup find expired-but-unresolved reservations without scanning all keys.
  reservationsExpiring: () => `reservations:expiring`,
  concurrency: (target: string, budgetKey: string) => `concurrency:${seg(target)}${seg(budgetKey)}`,
  retries: (target: string) => `retries:${seg(target)}`,
  circuit: (target: string) => `circuit:${seg(target)}`,
};