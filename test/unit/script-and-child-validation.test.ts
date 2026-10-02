import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { registerChild } from "../../src/agents/register-child.js";
import { parseConfig } from "../../src/config/index.js";
import { BrokerArgumentError } from "../../src/errors/index.js";
import { defineScript, runScript } from "../../src/redis/script.js";

const fake = {} as Redis; // any use of the connection would throw a TypeError, failing the test
const config = parseConfig({ redis: fake });

describe("child registration validation", () => {
  it.each([
    ["empty parentId", { parentId: "" }],
    ["non-string parentId", { parentId: 7 }],
    ["missing parentId", {}],
    ["parentId explicitly undefined", { parentId: undefined }],
    ["null options", null],
  ])("rejects before touching Redis: %s", async (_label, input) => {
    await expect(registerChild(config, input as never)).rejects.toBeInstanceOf(BrokerArgumentError);
  });

  // Invariants 1 and 2: nothing derived may be asserted by the caller.
  it.each(["depth", "rootId", "budgetKey", "initialBudget", "agentId"])(
    "rejects caller-supplied %s",
    async (field) => {
      await expect(registerChild(config, { parentId: "p", [field]: 0 } as never)).rejects.toThrow(field);
    },
  );
});

describe("runScript", () => {
  it("rejects a key-count mismatch before touching Redis", async () => {
    await expect(runScript(fake, defineScript("return 1", 2), ["only-one"], [])).rejects.toThrow("expects 2 keys");
  });
});