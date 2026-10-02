import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { BrokerArgumentError } from "../../src/errors/index.js";
import { reportOutcome } from "../../src/admission/report-outcome.js";

const fake = {} as Redis;
const config = parseConfig({ redis: fake });

describe("reportOutcome() validation", () => {
  it.each([
    ["missing reservationId", { success: true }],
    ["empty reservationId", { reservationId: "", success: true }],
    ["missing success", { reservationId: "r" }],
    ["non-boolean success", { reservationId: "r", success: "yes" }],
    ["negative actualCost", { reservationId: "r", success: true, actualCost: -1 }],
    ["fractional actualCost", { reservationId: "r", success: true, actualCost: 1.5 }],
    ["null options", null],
  ])("rejects before touching Redis: %s", async (_label, input) => {
    await expect(reportOutcome(config, input as never)).rejects.toBeInstanceOf(BrokerArgumentError);
  });

  it("rejects an unknown field", async () => {
    await expect(reportOutcome(config, { reservationId: "r", success: true, foo: 1 } as never)).rejects.toThrow("foo");
  });

  it("accepts actualCost: 0 as valid (a call that genuinely cost nothing)", async () => {
    // Would reach Redis next and throw a TypeError on the fake client — proves validation passed.
    await expect(reportOutcome(config, { reservationId: "r", success: true, actualCost: 0 })).rejects.not.toBeInstanceOf(
      BrokerArgumentError,
    );
  });
});