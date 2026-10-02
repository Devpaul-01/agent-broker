import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { registerRoot, type RegisterRootInput } from "../../src/agents/register.js";
import { parseConfig } from "../../src/config/index.js";
import { BrokerArgumentError } from "../../src/errors/index.js";

// If validation ever ran after Redis, this would fail with a TypeError instead.
const config = parseConfig({ redis: {} as Redis });
const reg = (input: unknown) => registerRoot(config, input as RegisterRootInput);

describe("register() validation", () => {
  it.each([
    ["no budgetKey and no initialBudget", {}],
    ["empty budgetKey", { budgetKey: "", initialBudget: 5 }],
    ["non-string budgetKey", { budgetKey: 42, initialBudget: 5 }],
    ["negative initialBudget", { budgetKey: "k", initialBudget: -1 }],
    ["fractional initialBudget", { budgetKey: "k", initialBudget: 1.5 }],
    ["NaN initialBudget", { budgetKey: "k", initialBudget: Number.NaN }],
    ["null options", null],
  ])("rejects before touching Redis: %s", async (_label, input) => {
    await expect(reg(input)).rejects.toBeInstanceOf(BrokerArgumentError);
  });

  // Invariants 1 and 2: identity fields can never be caller-asserted.
  it.each(["agentId", "depth", "rootId", "parentId"])("rejects caller-supplied %s", async (field) => {
    await expect(reg({ initialBudget: 5, [field]: "x" })).rejects.toThrow(field);
  });
});