import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { type BrokerOptions, parseConfig } from "../../src/config/index.js";
import { BrokerConfigError } from "../../src/errors/index.js";

const redis = {} as Redis; // config validation never touches the connection
const opts = (o: Record<string, unknown> = {}) => ({ redis, ...o }) as BrokerOptions;

describe("parseConfig", () => {
  it("applies documented defaults, failing closed when Redis is unavailable", () => {
    const cfg = parseConfig(opts());
    expect(cfg).toMatchObject({
      maxDepth: 5,
      defaultReservationTtl: 30_000,
      maxReservationTtl: 300_000,
      onRedisUnavailable: "deny",
      circuitBreaker: { softThreshold: 5, hardThreshold: 20, windowMs: 60_000, probeRate: 0.1 },
    });
  });

  it("accepts maxDepth 0 (roots only, no delegation)", () => {
    expect(parseConfig(opts({ maxDepth: 0 })).maxDepth).toBe(0);
  });

  // ADR-19: config is immutable for the broker's lifetime.
  it("returns frozen config that does not alias the caller's objects", () => {
    const circuitBreaker = { softThreshold: 3 };
    const cfg = parseConfig(opts({ circuitBreaker }));
    circuitBreaker.softThreshold = 999;
    expect(cfg.circuitBreaker.softThreshold).toBe(3);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.circuitBreaker)).toBe(true);
  });

  it("rejects a missing redis client", () => {
    expect(() => parseConfig({} as BrokerOptions)).toThrow(BrokerConfigError);
  });

  it.each([
    ["maxDepth negative", { maxDepth: -1 }, "maxDepth"],
    ["maxDepth fractional", { maxDepth: 1.5 }, "maxDepth"],
    ["defaultReservationTtl zero", { defaultReservationTtl: 0 }, "defaultReservationTtl"],
    ["default TTL above max", { defaultReservationTtl: 400_000 }, "defaultReservationTtl"],
    ["agentTtl below maxReservationTtl", { agentTtl: 1_000 }, "agentTtl"],
    ["soft threshold above default hard", { circuitBreaker: { softThreshold: 25 } }, "hardThreshold"],
    ["soft equals hard", { circuitBreaker: { softThreshold: 10, hardThreshold: 10 } }, "hardThreshold"],
    ["windowMs zero", { circuitBreaker: { windowMs: 0 } }, "windowMs"],
    ["probeRate zero", { circuitBreaker: { probeRate: 0 } }, "probeRate"],
    ["probeRate above one", { circuitBreaker: { probeRate: 1.5 } }, "probeRate"],
    ["probeRate NaN", { circuitBreaker: { probeRate: Number.NaN } }, "probeRate"],
    ["unknown onRedisUnavailable", { onRedisUnavailable: "maybe" }, "onRedisUnavailable"],
  ])("rejects: %s", (_label, override, field) => {
    expect(() => parseConfig(opts(override))).toThrow(BrokerConfigError);
    expect(() => parseConfig(opts(override))).toThrow(field);
  });
});