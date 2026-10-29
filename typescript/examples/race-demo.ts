/**
 * Race demo: N independent OS processes ask for budget at the same moment.
 * The pool holds exactly 3 calls' worth (3 x 100). The broker must admit exactly 3.
 *
 *   npm run demo:race            (needs Redis; REDIS_URL defaults to redis://localhost:6379/14)
 *   npm run demo:race -- 40      (40 processes)
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { createBroker } from "../src/index.js";

const url = process.env.REDIS_URL ?? "redis://localhost:6379/14";
const procs = Number(process.argv[2] ?? 30);
const redis = new Redis(url);
const broker = createBroker({ redis });
const root = await broker.register({ budgetKey: `demo-${randomUUID()}`, initialBudget: 300 });
if (!("agentId" in root)) throw new Error("registration failed");

console.log(`${procs} processes racing for a budget that covers 3 calls...`);
const results = await Promise.all(
  Array.from({ length: procs }, (_, i) =>
    new Promise<{ allowed: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "examples/race-worker.ts", url, root.agentId, String(i)], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      child.stdout.on("data", (b) => (out += b));
      child.on("error", reject);
      child.on("close", () => resolve(JSON.parse(out.trim().split("\n").pop()!)));
    }),
  ),
);
const admitted = results.filter((r) => r.allowed).length;
console.log(`admitted: ${admitted}   denied: ${procs - admitted}   ${admitted === 3 ? "OK exactly 3" : "OVERSPENT"}`);
redis.disconnect();
process.exit(admitted === 3 ? 0 : 1);
