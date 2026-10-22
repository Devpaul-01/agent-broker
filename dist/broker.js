import { registerChild } from "./agents/register-child.js";
import { registerRoot } from "./agents/register.js";
import { requestPermission as requestPermissionImpl } from "./admission/request-permission.js";
import { requestPermissionQueued } from "./admission/queue.js";
import { reportOutcome as reportOutcomeImpl } from "./admission/report-outcome.js";
import { parseConfig } from "./config/index.js";
import { deregister } from "./agents/deregister.js";
import { addBudget } from "./budget/add-budget.js";
export function createBroker(options) {
    const config = parseConfig(options);
    async function register(input) {
        if (input !== null && typeof input === "object" && "parentId" in input) {
            return registerChild(config, input);
        }
        return (await registerRoot(config, input)).agent;
    }
    async function requestPermissionDispatch(input, queueOptions) {
        if (queueOptions === undefined)
            return requestPermissionImpl(config, input);
        return requestPermissionQueued(config, input, queueOptions, requestPermissionImpl);
    }
    return Object.freeze({
        register,
        requestPermission: requestPermissionDispatch,
        reportOutcome: (input) => reportOutcomeImpl(config, input),
        deregister: (agentId) => deregister(config, agentId),
        addBudget: (budgetKey, amount) => addBudget(config, budgetKey, amount),
    });
}
