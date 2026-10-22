import type { ResolvedConfig } from "../config/index.js";
export interface RegisterRootInput {
    budgetKey?: string;
    initialBudget?: number;
}
export interface RootAgent {
    agentId: string;
    depth: 0;
    rootId: string;
    budgetKey: string;
}
/**
 * Registers a root agent.
 *
 * Redis: one MULTI/EXEC block holds three commands that run without interleaving from other
 * connections: HSET agent record, PEXPIRE it, and SET budget NX (first creation wins).
 * MULTI is not rollback: if a command errors the others still ran, so we surface the error.
 * A connection drop before the reply leaves us not knowing whether it applied. The outcomes
 * are an orphan agent nobody holds an ID for (expires by TTL) and/or a created pool, and both
 * are harmless, which is why no stronger mechanism is needed here.
 */
export declare function registerRoot(config: ResolvedConfig, input: RegisterRootInput): Promise<{
    agent: RootAgent;
    poolCreated: boolean;
}>;
