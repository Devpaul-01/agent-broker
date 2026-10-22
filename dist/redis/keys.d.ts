export declare const keys: {
    agent: (agentId: string) => string;
    budget: (budgetKey: string) => string;
    reservation: (reservationId: string) => string;
    reservationsExpiring: () => string;
    concurrency: (target: string, budgetKey: string) => string;
    circuit: (target: string) => string;
    circuitState: (target: string) => string;
};
