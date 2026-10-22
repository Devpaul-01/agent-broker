import type { ResolvedConfig } from "../config/index.js";
export interface RegisterChildInput {
    parentId: string;
}
export interface ChildAgent {
    agentId: string;
    depth: number;
    rootId: string;
    budgetKey: string;
}
export type RegisterDenialReason = "depth_exceeded" | "unknown_agent";
export interface RegisterDenial {
    allowed: false;
    reason: RegisterDenialReason;
}
export declare function registerChild(config: ResolvedConfig, input: RegisterChildInput): Promise<ChildAgent | RegisterDenial>;
