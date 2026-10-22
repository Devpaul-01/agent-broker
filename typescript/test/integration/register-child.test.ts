import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerChild, type ChildAgent } from "../../src/agents/register-child.js";
import { registerRoot } from "../../src/agents/register.js";
import { parseConfig } from "../../src/config/index.js";
import { BrokerArgumentError } from "../../src/errors/index.js";
import { keys } from "../../src/redis/keys.js";
import { connectTestRedis } from "../helpers/redis.js";

describe("child registration (real Redis)", () => {
  let redis: Redis;
  let config: ReturnType<typeof parseConfig>;

  const agentCount = async () => (await redis.keys("agent:*")).length;
  const mustAllow = (r: Awaited<ReturnType<typeof registerChild>>): ChildAgent => {
    if ("allowed" in r) throw new Error(`expected registration, got denial: ${r.reason}`);
    return r;
  };

  beforeAll(async () => {
    redis = await connectTestRedis();
    config = parseConfig({ redis, maxDepth: 3 });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis?.quit();
  });

  it("derives depth, rootId and budgetKey from the parent without touching the parent's TTL", async () => {
    const { agent: root } = await registerRoot(config, { budgetKey: "user-1", initialBudget: 100 });
    await redis.pexpire(keys.agent(root.agentId), 5_000);

    const child = mustAllow(await registerChild(config, { parentId: root.agentId }));

    expect(child).toMatchObject({ depth: 1, rootId: root.agentId, budgetKey: "user-1" });
    expect(child.agentId).not.toBe(root.agentId);
    expect(await redis.hgetall(keys.agent(child.agentId))).toMatchObject({
      parentId: root.agentId, depth: "1", rootId: root.agentId, budgetKey: "user-1",
    });
    expect(await redis.pttl(keys.agent(child.agentId))).toBeGreaterThan(0);
    // Heartbeats belong to requestPermission/reportOutcome, not to registration.
    expect(await redis.pttl(keys.agent(root.agentId))).toBeLessThanOrEqual(5_000);
  });

  // Invariant 3: depth cap enforced at registration, and a denial writes nothing.
  it("allows a chain down to maxDepth and denies one more without writing state", async () => {
    const { agent: root } = await registerRoot(config, { budgetKey: "k", initialBudget: 10 });
    let parent: { agentId: string } = root;
    for (let depth = 1; depth <= 3; depth++) {
      const child = mustAllow(await registerChild(config, { parentId: parent.agentId }));
      expect(child.depth).toBe(depth);
      parent = child;
    }
    expect(await agentCount()).toBe(4);

    const over = await registerChild(config, { parentId: parent.agentId });
    expect(over).toEqual({ allowed: false, reason: "depth_exceeded" });
    expect(await agentCount()).toBe(4);
  });

  // Section 14 test 3, malicious variant, at the single-process level. The cross-process
  // version comes with the harness later.
  it("cannot be tricked by a self-reported lower depth", async () => {
    const { agent: root } = await registerRoot(config, { budgetKey: "k", initialBudget: 10 });
    const a = mustAllow(await registerChild(config, { parentId: root.agentId }));
    const b = mustAllow(await registerChild(config, { parentId: a.agentId }));
    const c = mustAllow(await registerChild(config, { parentId: b.agentId })); // depth 3 = maxDepth
    const before = await agentCount();

    for (const lie of [{ depth: 0 }, { rootId: root.agentId }, { budgetKey: "other-pool" }]) {
      await expect(
        registerChild(config, { parentId: c.agentId, ...lie } as never),
      ).rejects.toBeInstanceOf(BrokerArgumentError);
    }
    expect(await registerChild(config, { parentId: c.agentId })).toEqual({ allowed: false, reason: "depth_exceeded" });
    expect(await agentCount()).toBe(before);
  });

  it("denies unknown_agent for a parent that never existed or has expired, writing nothing", async () => {
    expect(await registerChild(config, { parentId: "never-issued" })).toEqual({ allowed: false, reason: "unknown_agent" });

    const { agent: root } = await registerRoot(config, { budgetKey: "k", initialBudget: 10 });
    await redis.del(keys.agent(root.agentId)); // deterministic stand-in for TTL expiry
    expect(await registerChild(config, { parentId: root.agentId })).toEqual({ allowed: false, reason: "unknown_agent" });
    expect(await agentCount()).toBe(0);
  });

  // Addresses the point from the exercise: siblings do not contend with each other.
  it("lets many siblings register concurrently without interference", async () => {
    const { agent: root } = await registerRoot(config, { budgetKey: "k", initialBudget: 10 });
    const clients = Array.from({ length: 20 }, () => redis.duplicate());
    try {
      const results = await Promise.all(
        clients.map((c) => registerChild(parseConfig({ redis: c, maxDepth: 3 }), { parentId: root.agentId })),
      );
      const children = results.map(mustAllow);
      expect(new Set(children.map((c) => c.agentId)).size).toBe(20);
      expect(children.every((c) => c.depth === 1 && c.rootId === root.agentId)).toBe(true);
      expect(await agentCount()).toBe(21);
    } finally {
      await Promise.all(clients.map((c) => c.quit()));
    }
  });
});