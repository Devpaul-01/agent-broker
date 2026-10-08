import { registerChild, type ChildAgent, type RegisterChildInput, type RegisterDenial } from "./agents/register-child.js";
import { registerRoot, type RegisterRootInput, type RootAgent } from "./agents/register.js";
import { type Admitted, type Denied, requestPermission as requestPermissionImpl, type RequestPermissionInput } from "./admission/request-permission.js";
import { requestPermissionQueued, type QueueOptions } from "./admission/queue.js";
import { type Resolved, type ReportDenial, reportOutcome as reportOutcomeImpl, type ReportOutcomeInput } from "./admission/report-outcome.js";
import { type BrokerOptions, parseConfig } from "./config/index.js";
import { deregister, type DeregisterResult } from "./agents/deregister.js";
import { addBudget, type AddBudgetResult, type AddBudgetDenial } from "./budget/add-budget.js";

export interface Broker {
  register(input: RegisterRootInput): Promise<RootAgent>;
  register(input: RegisterChildInput): Promise<ChildAgent | RegisterDenial>;
  requestPermission(input: RequestPermissionInput): Promise<Admitted | Denied>;
  requestPermission(input: RequestPermissionInput, queueOptions: QueueOptions): Promise<Admitted | Denied>;
  reportOutcome(input: ReportOutcomeInput): Promise<Resolved | ReportDenial>;
  deregister(agentId: string): Promise<DeregisterResult>;
  addBudget(budgetKey: string, amount: number): Promise<AddBudgetResult | AddBudgetDenial>;
}

export function createBroker(options: BrokerOptions): Broker {
  const config = parseConfig(options);

  async function register(input: RegisterRootInput): Promise<RootAgent>;
  async function register(input: RegisterChildInput): Promise<ChildAgent | RegisterDenial>;
  async function register(input: RegisterRootInput | RegisterChildInput) {
    if (input !== null && typeof input === "object" && "parentId" in input) {
      return registerChild(config, input);
    }
    return (await registerRoot(config, input)).agent;
  }

  async function requestPermissionDispatch(
    input: RequestPermissionInput,
    queueOptions?: QueueOptions,
  ): Promise<Admitted | Denied> {
    if (queueOptions === undefined) return requestPermissionImpl(config, input);
    return requestPermissionQueued(config, input, queueOptions, requestPermissionImpl);
  }

  return Object.freeze({
    register,
    requestPermission: requestPermissionDispatch,
    reportOutcome: (input: ReportOutcomeInput) => reportOutcomeImpl(config, input),
    deregister: (agentId: string) => deregister(config, agentId),
    addBudget: (budgetKey: string, amount: number) => addBudget(config, budgetKey, amount),
  });
}