/**
 * Shared run-metadata collection for every benchmark/experiment script in measurement/bench/.
 * Centralized so every result file records the same fields the same way (MEASUREMENT_PLAN.md
 * §"Cross-cutting notes": Redis version/config, Node version, OS/CPU, commit SHA, timestamp).
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { Redis } from "ioredis";

export interface RunMetadata {
  runId: string;
  timestampUtc: string;
  repo: {
    url: string;
    commitSha: string;
    branch: string;
    dirty: boolean;
  };
  runtime: {
    node: string;
    os: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    totalMemoryGb: number;
  };
  redis: {
    version: string | "unavailable";
  };
  dependencies: {
    ioredis: string;
    typescript: string;
    tsx: string;
    vitest: string;
  };
}

function safeExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

export async function collectRunMetadata(redis?: Redis): Promise<RunMetadata> {
  const fs = await import("node:fs/promises");
  const pkg = JSON.parse(
    await fs.readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { devDependencies: Record<string, string> };

  let redisVersion: string | "unavailable" = "unavailable";
  if (redis) {
    try {
      const info = await redis.info("server");
      const match = info.match(/redis_version:(\S+)/);
      if (match) redisVersion = match[1];
    } catch {
      redisVersion = "unavailable";
    }
  }

  const dirty = safeExec("git status --porcelain -- src test") !== "";

  return {
    runId: randomUUID(),
    timestampUtc: new Date().toISOString(),
    repo: {
      url: "https://github.com/Devpaul-01/agent-broker",
      commitSha: safeExec("git rev-parse HEAD"),
      branch: safeExec("git rev-parse --abbrev-ref HEAD"),
      dirty,
    },
    runtime: {
      node: process.version,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      cpuCount: os.cpus().length,
      totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 100) / 100,
    },
    redis: { version: redisVersion },
    dependencies: {
      ioredis: pkg.devDependencies.ioredis,
      typescript: pkg.devDependencies.typescript,
      tsx: pkg.devDependencies.tsx,
      vitest: pkg.devDependencies.vitest,
    },
  };
}

/** Percentile of a sorted-ascending numeric array using the nearest-rank method. */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) throw new Error("percentile() called on an empty sample");
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, idx))];
}

export function summarizeLatencies(samplesMs: number[]): {
  n: number;
  minMs: number;
  maxMs: number;
  medianMs: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  meanMs: number;
  stdDevMs: number;
} {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  return {
    n,
    minMs: Math.round(sorted[0] * 100) / 100,
    maxMs: Math.round(sorted[n - 1] * 100) / 100,
    medianMs: Math.round(percentile(sorted, 50) * 100) / 100,
    p90Ms: Math.round(percentile(sorted, 90) * 100) / 100,
    p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
    p99Ms: Math.round(percentile(sorted, 99) * 100) / 100,
    meanMs: Math.round(mean * 100) / 100,
    stdDevMs: Math.round(Math.sqrt(variance) * 100) / 100,
  };
}

/** Writes a result object to measurement/results/<experiment>/<runId>.json — never overwrites. */
export async function saveResult(experiment: string, runId: string, data: unknown): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = path.join(new URL("../results", import.meta.url).pathname, experiment);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${runId}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", { flag: "wx" }); // 'wx' = fail if exists, never silently overwrite
  return filePath;
}
