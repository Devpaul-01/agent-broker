import type { ResolvedConfig } from "../config/index.js";
export type AddBudgetDenialReason = "unknown_budget";
export interface AddBudgetResult {
    added: true;
    newBalance: number;
}
export interface AddBudgetDenial {
    added: false;
    reason: AddBudgetDenialReason;
}
export declare function addBudget(config: ResolvedConfig, budgetKey: string, amount: number): Promise<AddBudgetResult | AddBudgetDenial>;
