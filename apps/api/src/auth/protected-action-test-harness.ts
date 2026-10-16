import type { Sql, TransactionSql } from "postgres";
import type { StepUpTestScope } from "./step-up-test-service.js";

const OWNER_ACTIONS = new Set(["business.invitation.create", "business.invitation.revoke"]);

export class ProtectedActionTestHarnessError extends Error {
  constructor(readonly code: "configuration" | "invalid_action") {
    super(code);
    this.name = "ProtectedActionTestHarnessError";
  }
}

export type TestProofConsumer = {
  consumeProofInTransaction(
    tx: TransactionSql,
    proofId: string,
    scope: StepUpTestScope,
  ): Promise<boolean>;
};

/**
 * Synthetic-only transaction harness. It is deliberately not imported by the
 * Fastify application; C2's Better Auth adapter transaction cannot currently
 * share this postgres.js transaction.
 */
export function createProtectedActionTestHarness(options: {
  client: Sql;
  proofConsumer: TestProofConsumer;
}) {
  const { database, host, path } = options.client.options;
  if (
    process.env.NODE_ENV !== "test" ||
    database !== "mizvo_test" ||
    path ||
    host.length !== 1 ||
    (host[0] !== "127.0.0.1" && host[0] !== "::1")
  ) {
    throw new ProtectedActionTestHarnessError("configuration");
  }

  async function authorizeAndRun<T>(input: {
    proofId: string;
    scope: StepUpTestScope;
    action: (tx: TransactionSql) => Promise<T>;
  }): Promise<{ allowed: false } | { allowed: true; result: T }> {
    if (!OWNER_ACTIONS.has(input.scope.action)) {
      throw new ProtectedActionTestHarnessError("invalid_action");
    }
    const configuredDatabase = await options.client`SELECT current_database() AS database`;
    if (configuredDatabase[0]?.database !== "mizvo_test") {
      throw new ProtectedActionTestHarnessError("configuration");
    }

    return options.client.begin(async (tx) => {
      const transactionDatabase = await tx`SELECT current_database() AS database`;
      if (transactionDatabase[0]?.database !== "mizvo_test") {
        throw new ProtectedActionTestHarnessError("configuration");
      }
      if (
        !(await options.proofConsumer.consumeProofInTransaction(tx, input.proofId, input.scope))
      ) {
        return { allowed: false };
      }
      return { allowed: true, result: await input.action(tx) };
    });
  }

  return { authorizeAndRun };
}
