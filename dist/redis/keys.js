/**
 * Every Redis key the library touches is built here, and nowhere else.
 *
 * Caller-supplied strings (target, budgetKey) are length-prefixed so that keys built from
 * several of them cannot be re-split ambiguously. Targets contain colons by convention
 * ("groq:llama-3.3-70b"), so a plain ":" separator would map ("a:b","c") and ("a","b:c")
 * to the same key and silently merge two unrelated concurrency counters (Invariant 13).
 * Broker-issued IDs (agent, reservation) are UUIDs and safe to use raw.
 */
const seg = (value) => `${value.length}:${value}`;
export const keys = {
    agent: (agentId) => `agent:${agentId}`,
    budget: (budgetKey) => `budget:${seg(budgetKey)}`,
    reservation: (reservationId) => `reservation:${reservationId}`,
    reservationsExpiring: () => `reservations:expiring`,
    concurrency: (target, budgetKey) => `concurrency:${seg(target)}${seg(budgetKey)}`,
    circuit: (target) => `circuit:${seg(target)}`,
    circuitState: (target) => `circuit:${seg(target)}:state`,
};
