import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { StepUpTestScope } from "./step-up-test-service.js";
import { getStepUpTestServiceForClient } from "./step-up-test-service.js";

const OWNER_ACTIONS = new Set(["business.invitation.create", "business.invitation.revoke"]);

export class ProtectedActionTestHarnessError extends Error {
  constructor(readonly code: "configuration" | "invalid_action") {
    super(code);
    this.name = "ProtectedActionTestHarnessError";
  }
}

/**
 * Synthetic-only transaction harness. The only mutation this API can perform
 * is its internally-built, proof-scoped fixture row. It is not imported by
 * Fastify because C2's Better Auth adapter cannot share this transaction.
 */
export function createProtectedActionTestHarness(options: { client: Sql; stepUp: unknown }) {
  const stepUpService = getStepUpTestServiceForClient(options.stepUp, options.client);
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
  if (!stepUpService) {
    throw new ProtectedActionTestHarnessError("configuration");
  }
  const proofConsumer = stepUpService;

  async function applySyntheticEffect(input: {
    proofId: string;
    scope: StepUpTestScope;
  }): Promise<{ allowed: false } | { allowed: true; effectId: string }> {
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
      const validated = await proofConsumer.consumeProofInTransaction(
        tx,
        input.proofId,
        input.scope,
      );
      if (!validated || !OWNER_ACTIONS.has(validated.action)) return { allowed: false };

      const effectId = randomUUID();
      await tx`
        INSERT INTO "protected_action_test_effect"
          ("id", "proof_id", "user_id", "business_id", "action", "target_digest")
        VALUES (
          ${effectId}, ${input.proofId}, ${validated.userId}, ${validated.businessId},
          ${validated.action}, ${validated.targetDigest}
        )
      `;
      return { allowed: true, effectId };
    });
  }

  return { applySyntheticEffect };
}
