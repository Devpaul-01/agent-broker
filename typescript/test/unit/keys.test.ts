import { describe, expect, it } from "vitest";
import { keys } from "../../src/redis/keys.js";

describe("keys", () => {
  // Invariant 13: unrelated (target, budgetKey) pairs must never share a counter.
  it("does not collide when a colon moves between target and budgetKey", () => {
    expect(keys.concurrency("a:b", "c")).not.toBe(keys.concurrency("a", "b:c"));
  });

  it("gives every (target, budgetKey) pair a distinct concurrency key", () => {
    const tricky = ["", "a", "b", "a:b", "b:a", ":", "::", "1:a", "2:ab", "a:", ":a", "groq:llama-3.3"];
    const seen = new Set<string>();
    for (const t of tricky) for (const b of tricky) seen.add(keys.concurrency(t, b));
    expect(seen.size).toBe(tricky.length ** 2);
  });

  it("keeps different key types in different namespaces", () => {
  const all = [keys.agent("x"), keys.budget("x"), keys.reservation("x"), keys.circuit("x")];
  expect(new Set(all).size).toBe(all.length);
});
});