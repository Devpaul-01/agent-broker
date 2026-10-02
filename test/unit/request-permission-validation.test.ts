import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { BrokerArgumentError } from "../../src/errors/index.js";
import { requestPermission } from "../../src/admission/request-permission.js";

const fake = {} as Redis; // touching it would throw a TypeError, failing the test
const config = parseConfig({ redis: fake, maxReservationTtl: 100_000 });
const base = { agentId: "a", target: "t", estimatedCost: 10 };

describe("requestPermission() validation", () => {
  it.each([
    ["missing agentId", { target: "t", estimatedCost: 10 }],
    ["empty agentId", { ...base, agentId: "" }],
    ["missing target", { agentId: "a", estimatedCost: 10 }],
    ["empty target", { ...base, target: "" }],
    ["missing estimatedCost", { agentId: "a", target: "t" }],
    ["zero estimatedCost", { ...base, estimatedCost: 0 }],
    ["negative estimatedCost", { ...base, estimatedCost: -1 }],
    ["fractional estimatedCost", { ...base, estimatedCost: 1.5 }],
    ["zero ttl", { ...base, ttl: 0 }],
    ["negative ttl", { ...base, ttl: -1 }],
    ["null options", null],
  ])("rejects before touching Redis: %s", async (_label, input) => {
    await expect(requestPermission(config, input as never)).rejects.toBeInstanceOf(BrokerArgumentError);
  });

  it("rejects a ttl above maxReservationTtl before touching Redis", async () => {
    await expect(requestPermission(config, { ...base, ttl: 20_000 })).rejects.toThrow("maxReservationTtl");
  });

  it("rejects an unknown field", async () => {
    await expect(requestPermission(config, { ...base, depth: 1 } as never)).rejects.toThrow("depth");
  });
});