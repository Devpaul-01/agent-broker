import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoot } from "../../src/agents/register.js";
import { addBudget } from "../../src/budget/add-budget.js";
import { parseConfig } from "../../src/config/index.js";
import { keys } from "../../src/redis/keys.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("addBudget (real Redis)", () => {
  let redis: Redis;
  let config: ReturnType<typeof parseConfig>;
  beforeAll(async () => { redis = await connectTestRedis(); config = parseConfig({ redis }); });
  beforeEach(async () => { await redis.flushdb(); });
  afterAll(async () => { await redis?.quit(); });

  it("tops up an existing pool and returns the new balance", async () => {
    await registerRoot(config, { budgetKey: "ab1", initialBudget: 500 });
    const result = await addBudget(config, "ab1", 200);
    expect(result).toEqual({ added: true, newBalance: 700 });
    expect(await redis.get(keys.budget("ab1"))).toBe("700");
  });

  it("denies unknown_budget without creating the pool, closing the same silent-recreation hazard as ADR-0003", async () => {
    const result = await addBudget(config, "never-registered", 100);
    expect(result).toEqual({ added: false, reason: "unknown_budget" });
    expect(await redis.exists(keys.budget("never-registered"))).toBe(0);
  });

  it.each([
    ["zero amount", 0],
    ["negative amount", -50],
    ["fractional amount", 10.5],
  ])("rejects %s before touching Redis", async (_label, amount) => {
    const fake = {} as Redis;
    const fakeConfig = parseConfig({ redis: fake });
    await expect(addBudget(fakeConfig, "k", amount)).rejects.toThrow("amount");
  });

  it("rejects an empty budgetKey before touching Redis", async () => {
    const fake = {} as Redis;
    const fakeConfig = parseConfig({ redis: fake });
    await expect(addBudget(fakeConfig, "", 100)).rejects.toThrow("budgetKey");
  });

  // Direct proof the atomic script closes the TOCTOU: many concurrent top-ups against one
  // pool must all land, none lost to a lost-update race (plain non-atomic read-then-write
  // would lose updates here; INCRBY via the script cannot).
  it("accumulates correctly under concurrent top-ups via real contention", async () => {
    await registerRoot(config, { budgetKey: "ab-race", initialBudget: 0 });
    const clients = Array.from({ length: 20 }, () => redis.duplicate());
    try {
      await Promise.all(clients.map((c) => addBudget(parseConfig({ redis: c }), "ab-race", 10)));
      expect(await redis.get(keys.budget("ab-race"))).toBe("200"); // 20 * 10, none lost
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });
});