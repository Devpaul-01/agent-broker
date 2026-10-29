// Worker for race-demo.ts. Runs in its own OS process: no memory shared with its siblings.
import { Redis } from "ioredis";
import { createBroker } from "../src/index.js";

const [url, agentId, id] = process.argv.slice(2);
const redis = new Redis(url!);
const broker = createBroker({ redis });
const d = await broker.requestPermission({ agentId: agentId!, target: "demo:model", estimatedCost: 100 });
console.log(JSON.stringify({ worker: Number(id), allowed: d.allowed }));
redis.disconnect();
