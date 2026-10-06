import { describe, expect, it } from "vitest";
import { isRedisUnavailableError } from "../../src/redis/unavailable.js";

describe("isRedisUnavailableError", () => {
  it.each([
    ["connect ECONNREFUSED 127.0.0.1:6379", true],
    ["connect ETIMEDOUT", true],
    ["getaddrinfo ENOTFOUND redis-host", true],
    ["Connection is closed.", true],
    ["Stream isn't writeable and enableOfflineQueue options is false", true],
  ])("treats %s as unavailable", (message, expected) => {
    expect(isRedisUnavailableError(new Error(message))).toBe(expected);
  });

  it.each([
    "WRONGTYPE Operation against a key holding the wrong kind of value",
    "unexpected reply from request-permission script: null",
    "some random application error",
  ])("does NOT treat a non-connection error as unavailable: %s", (message) => {
    expect(isRedisUnavailableError(new Error(message))).toBe(false);
  });

  it("does not treat a non-Error thrown value as unavailable", () => {
    expect(isRedisUnavailableError("a string, not an Error")).toBe(false);
    expect(isRedisUnavailableError(undefined)).toBe(false);
  });
});