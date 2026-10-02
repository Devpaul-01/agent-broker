import { registerChild, type ChildAgent, type RegisterChildInput, type RegisterDenial } from "./agents/register-child.js";
import { registerRoot, type RegisterRootInput, type RootAgent } from "./agents/register.js";
import { type BrokerOptions, parseConfig } from "./config/index.js";

export interface Broker {
  register(input: RegisterRootInput): Promise<RootAgent>;
  register(input: RegisterChildInput): Promise<ChildAgent | RegisterDenial>;
}

export function createBroker(options: BrokerOptions): Broker {
  const config = parseConfig(options);

  async function register(input: RegisterRootInput): Promise<RootAgent>;
  async function register(input: RegisterChildInput): Promise<ChildAgent | RegisterDenial>;
  async function register(input: RegisterRootInput | RegisterChildInput) {
    // The presence of the key decides, even when its value is undefined, so a caller cannot
    // slip past child validation by sending parentId: undefined.
    if (input !== null && typeof input === "object" && "parentId" in input) {
      return registerChild(config, input);
    }
    return (await registerRoot(config, input)).agent;
  }

  return Object.freeze({ register });
}