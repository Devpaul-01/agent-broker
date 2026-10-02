import { registerRoot, type RegisterRootInput, type RootAgent } from "./agents/register.js";
import { type BrokerOptions, parseConfig } from "./config/index.js";

export interface Broker {
  register(input?: RegisterRootInput): Promise<RootAgent>;
}

export function createBroker(options: BrokerOptions): Broker {
  const config = parseConfig(options);
  return Object.freeze({
    async register(input: RegisterRootInput = {}): Promise<RootAgent> {
      return (await registerRoot(config, input)).agent;
    },
  });
}