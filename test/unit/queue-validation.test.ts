import { describe, expect, it } from "vitest";
import { validateQueueOptions } from "../../src/admission/queue.js";
import { BrokerArgumentError } from "../../src/errors/index.js";

describe("validateQueueOptions", () => {
  it.each([
    ["wrong mode", { mode: "wait", queueTimeout: 1000 }],
    ["missing queueTimeout", { mode: "queue" }],
    ["zero queueTimeout", { mode: "queue", queueTimeout: 0 }],
    ["negative queueTimeout", { mode: "queue", queueTimeout: -1 }],
    ["fractional queueTimeout", { mode: "queue", queueTimeout: 1.5 }],
    ["null options", null],
  ])("rejects: %s", (_label, input) => {
    expect(() => validateQueueOptions(input)).toThrow(BrokerArgumentError);
  });

  it("accepts a valid AbortSignal", () => {
  const controller = new AbortController();
  expect(() => validateQueueOptions({ mode: "queue", queueTimeout: 1000, signal: controller.signal })).not.toThrow();
});

it("rejects a non-AbortSignal value for signal", () => {
  expect(() => validateQueueOptions({ mode: "queue", queueTimeout: 1000, signal: "not-a-signal" })).toThrow(BrokerArgumentError);
});

  it("accepts a valid queue options object", () => {
    expect(() => validateQueueOptions({ mode: "queue", queueTimeout: 5000 })).not.toThrow();
  });
});