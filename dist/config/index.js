import { BrokerConfigError } from "../errors/index.js";
function int(name, value, fallback, min) {
    const v = value ?? fallback;
    if (!Number.isSafeInteger(v) || v < min) {
        throw new BrokerConfigError(`${name} must be an integer >= ${min}, got ${String(v)}`);
    }
    return v;
}
export function parseConfig(options) {
    if (options == null || options.redis == null) {
        throw new BrokerConfigError("redis is required: pass the ioredis client the broker should use");
    }
    const concurrencyLimit = int("concurrencyLimit", options.concurrencyLimit, 10, 1);
    const maxDepth = int("maxDepth", options.maxDepth, 5, 0);
    const defaultReservationTtl = int("defaultReservationTtl", options.defaultReservationTtl, 30_000, 1);
    const maxReservationTtl = int("maxReservationTtl", options.maxReservationTtl, 300_000, 1);
    const agentTtl = int("agentTtl", options.agentTtl, 3_600_000, 1);
    if (defaultReservationTtl > maxReservationTtl) {
        throw new BrokerConfigError(`defaultReservationTtl (${defaultReservationTtl}) cannot exceed maxReservationTtl (${maxReservationTtl})`);
    }
    if (agentTtl < maxReservationTtl) {
        throw new BrokerConfigError(`agentTtl (${agentTtl}) must be >= maxReservationTtl (${maxReservationTtl}), ` +
            `or an agent could expire while its call is still in flight`);
    }
    const onRedisUnavailable = options.onRedisUnavailable ?? "deny";
    if (onRedisUnavailable !== "deny" && onRedisUnavailable !== "allow") {
        throw new BrokerConfigError(`onRedisUnavailable must be 'deny' or 'allow', got ${String(onRedisUnavailable)}`);
    }
    const cb = options.circuitBreaker ?? {};
    const softThreshold = int("circuitBreaker.softThreshold", cb.softThreshold, 5, 1);
    const hardThreshold = int("circuitBreaker.hardThreshold", cb.hardThreshold, 20, 1);
    const windowMs = int("circuitBreaker.windowMs", cb.windowMs, 60_000, 1);
    const probeRate = cb.probeRate ?? 0.1;
    if (hardThreshold <= softThreshold) {
        throw new BrokerConfigError(`circuitBreaker.hardThreshold (${hardThreshold}) must exceed softThreshold (${softThreshold})`);
    }
    if (!Number.isFinite(probeRate) || probeRate <= 0 || probeRate > 1) {
        throw new BrokerConfigError(`circuitBreaker.probeRate must be in (0, 1] so recovery probes are never disabled, got ${String(probeRate)}`);
    }
    const hooks = options.hooks ?? {};
    for (const [name, fn] of Object.entries(hooks)) {
        if (fn !== undefined && typeof fn !== "function") {
            throw new BrokerConfigError(`hooks.${name} must be a function, got ${typeof fn}`);
        }
    }
    return Object.freeze({
        redis: options.redis,
        maxDepth, agentTtl, defaultReservationTtl, maxReservationTtl, concurrencyLimit, onRedisUnavailable,
        circuitBreaker: Object.freeze({ softThreshold, hardThreshold, windowMs, probeRate }),
        hooks: Object.freeze({ ...hooks }),
    });
}
