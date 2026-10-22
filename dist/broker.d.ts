import { type ChildAgent, type RegisterChildInput, type RegisterDenial } from "./agents/register-child.js";
import { type RegisterRootInput, type RootAgent } from "./agents/register.js";
import { type Admitted, type Denied, type RequestPermissionInput } from "./admission/request-permission.js";
import { type QueueOptions } from "./admission/queue.js";
import { type Resolved, type ReportDenial, type ReportOutcomeInput } from "./admission/report-outcome.js";
import { type BrokerOptions } from "./config/index.js";
import { type DeregisterResult } from "./agents/deregister.js";
import { type AddBudgetResult, type AddBudgetDenial } from "./budget/add-budget.js";
export interface Broker {
    register(input: RegisterRootInput): Promise<RootAgent>;
    register(input: RegisterChildInput): Promise<ChildAgent | RegisterDenial>;
    requestPermission(input: RequestPermissionInput): Promise<Admitted | Denied>;
    requestPermission(input: RequestPermissionInput, queueOptions: QueueOptions): Promise<Admitted | Denied>;
    reportOutcome(input: ReportOutcomeInput): Promise<Resolved | ReportDenial>;
    deregister(agentId: string): Promise<DeregisterResult>;
    addBudget(budgetKey: string, amount: number): Promise<AddBudgetResult | AddBudgetDenial>;
}
export declare function createBroker(options: BrokerOptions): Broker;
