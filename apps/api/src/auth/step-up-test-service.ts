import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  type PublicKeyCredentialRequestOptionsJSON,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { Sql, TransactionSql } from "postgres";

const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";
const CHALLENGE_LIFETIME_MS = 5 * 60_000;
const PROOF_LIFETIME_MS = 10 * 60_000;
const CHALLENGE_RATE_WINDOW_MS = 5 * 60_000;
const CHALLENGE_RATE_MAX = 30;
const ALLOWED_ACTIONS = new Set([
  "business.invitation.create",
  "business.invitation.revoke",
  "business.member.remove",
  "business.member.role_change",
]);

export type StepUpTestScope = {
  userId: string;
  sessionId: string;
  businessId: string;
  action: string;
  target: string;
};

type Scope = StepUpTestScope;

export type ConsumedStepUpTestProof = Pick<StepUpTestScope, "userId" | "businessId" | "action"> & {
  targetDigest: string;
};

const stepUpTestServiceClients = new WeakMap<object, Sql>();

export type StepUpTestProofConsumer = {
  consumeProofInTransaction(
    tx: TransactionSql,
    proofId: string,
    scope: Scope,
  ): Promise<ConsumedStepUpTestProof | null>;
};

/** The protected-action test harness accepts only a genuine C3c service created for its client. */
export function getStepUpTestServiceForClient(
  value: unknown,
  client: Sql,
): StepUpTestProofConsumer | null {
  if (
    typeof value !== "object" ||
    value === null ||
    stepUpTestServiceClients.get(value) !== client
  ) {
    return null;
  }
  return value as StepUpTestProofConsumer;
}

type Challenge = {
  id: string;
  challenge_hash: string;
  user_id: string;
  session_id: string;
  business_id: string;
  credential_id: string;
  credential_fingerprint: string;
  credential_counter: number;
  membership_role: string;
  action: string;
  target_digest: string;
  security_epoch: number;
  recovery_activity_count: number;
  current_security_epoch: number;
  current_recovery_activity_count: number;
  expires_at_utc_ms: number;
  consumed_at: Date | string | null;
  public_key: string;
  current_counter: number;
  transports: string | null;
  session_expires_at_utc_ms: number;
  phone_number_verified: boolean | null;
  email_verified: boolean;
  current_role: string;
};

export class StepUpTestServiceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepUpTestServiceConfigurationError";
  }
}

export class StepUpTestServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepUpTestServiceError";
  }
}

function isLocalTestClient(client: Sql) {
  const { database, host, path } = client.options;
  return (
    database === "mizvo_test" &&
    !path &&
    host.length === 1 &&
    (host[0] === "127.0.0.1" || host[0] === "::1")
  );
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function targetDigest(target: string) {
  if (target.length < 1 || target.length > 512) {
    throw new StepUpTestServiceError("Step-up target is invalid");
  }
  return sha256(target);
}

function credentialFingerprint(publicKey: string) {
  // Better Auth stores the credential public key as base64. Hash decoded bytes
  // so harmless base64 padding differences cannot change credential identity.
  return sha256(Buffer.from(publicKey, "base64"));
}

function challengeMatches(challenge: string, storedHash: string) {
  const candidate = Buffer.from(sha256(challenge), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function isScopeValid(scope: Scope) {
  return Boolean(
    scope.userId &&
      scope.sessionId &&
      scope.businessId &&
      ALLOWED_ACTIONS.has(scope.action) &&
      targetDigest(scope.target),
  );
}

async function assertIsolatedTestDatabase(client: Sql, query: Sql | TransactionSql) {
  if (!isLocalTestClient(client)) {
    throw new StepUpTestServiceConfigurationError(
      "Step-up test service requires a loopback connection to mizvo_test",
    );
  }
  const rows = await query`SELECT current_database() AS database`;
  if (rows[0]?.database !== "mizvo_test") {
    throw new StepUpTestServiceConfigurationError(
      "Step-up test service requires the isolated local mizvo_test database",
    );
  }
}

async function recordAudit(
  query: Sql | TransactionSql,
  scope: Pick<Scope, "userId" | "businessId">,
  fingerprint: string | null,
  event: string,
  outcome: string,
) {
  await query`
    INSERT INTO "step_up_test_audit_event"
      ("id", "user_id", "business_id", "credential_fingerprint", "event", "outcome")
    VALUES (${randomUUID()}, ${scope.userId}, ${scope.businessId}, ${fingerprint}, ${event}, ${outcome})
  `;
}

async function loadChallenge(client: Sql, challengeId: string): Promise<Challenge | null> {
  const rows = await client<Challenge[]>`
    SELECT challenge."id", challenge."challenge_hash", challenge."user_id", challenge."session_id",
      challenge."business_id", challenge."credential_id", challenge."credential_fingerprint",
      challenge."credential_counter", challenge."membership_role", challenge."action",
      challenge."target_digest", challenge."security_epoch", challenge."recovery_activity_count",
      challenge."consumed_at",
      (EXTRACT(EPOCH FROM (challenge."expires_at" AT TIME ZONE 'UTC')) * 1000)::double precision AS "expires_at_utc_ms",
      credential."public_key", credential."counter" AS "current_counter", credential."transports",
      test_identity."security_epoch" AS "current_security_epoch",
      (SELECT count(*)::int FROM "recovery_audit_event" audit
        WHERE audit."user_id" = challenge."user_id") AS "current_recovery_activity_count",
      (EXTRACT(EPOCH FROM (auth_session."expires_at" AT TIME ZONE 'UTC')) * 1000)::double precision AS "session_expires_at_utc_ms",
      account_user."phone_number_verified", account_user."email_verified",
      membership."role" AS "current_role"
    FROM "step_up_challenge" challenge
    INNER JOIN "step_up_test_identity" test_identity
      ON test_identity."user_id" = challenge."user_id"
    INNER JOIN "user" account_user ON account_user."id" = challenge."user_id"
    INNER JOIN "session" auth_session
      ON auth_session."id" = challenge."session_id"
      AND auth_session."user_id" = challenge."user_id"
    INNER JOIN "member" membership
      ON membership."organization_id" = challenge."business_id"
      AND membership."user_id" = challenge."user_id"
    INNER JOIN "passkey" credential
      ON credential."credential_id" = challenge."credential_id"
      AND credential."user_id" = challenge."user_id"
    WHERE challenge."id" = ${challengeId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const challenge = rows[0] as Challenge;
  return challenge;
}

function scopeMatches(challenge: Challenge, scope: Scope) {
  return (
    challenge.user_id === scope.userId &&
    challenge.session_id === scope.sessionId &&
    challenge.business_id === scope.businessId &&
    challenge.action === scope.action &&
    challenge.target_digest === targetDigest(scope.target)
  );
}

/**
 * Internal PostgreSQL state machine for C3c's development/test-only verifier.
 * It is intentionally not imported by Fastify, Better Auth, or the C2 guard.
 */
export function createStepUpTestService(options: { client: Sql }) {
  const client = options.client;
  if (!isLocalTestClient(client)) {
    throw new StepUpTestServiceConfigurationError(
      "Step-up test service requires a loopback connection to mizvo_test",
    );
  }
  if (process.env.NODE_ENV !== "test") {
    throw new StepUpTestServiceConfigurationError("Step-up test service is test-only");
  }

  async function isEligibleSyntheticOwner(scope: Scope) {
    const rows = await client`
      SELECT test_identity."security_epoch", membership."role"
      FROM "step_up_test_identity" test_identity
      INNER JOIN "user" account_user ON account_user."id" = test_identity."user_id"
      INNER JOIN "member" membership ON membership."user_id" = account_user."id"
      WHERE test_identity."user_id" = ${scope.userId}
        AND test_identity."designation" = 'synthetic_fixture'
        AND account_user."phone_number_verified" = true
        AND account_user."email_verified" = false
        AND membership."organization_id" = ${scope.businessId}
        AND membership."role" = 'owner'
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async function consumeChallengeFailure(
    id: string,
    _scope: Scope,
    fingerprint: string | null,
    outcome: "rejected" | "replayed" | "stale",
  ) {
    await client.begin(async (tx) => {
      const challenges = await tx`
        SELECT "user_id", "business_id" FROM "step_up_challenge" WHERE "id" = ${id}
      `;
      await tx`
        UPDATE "step_up_challenge" SET "consumed_at" = COALESCE("consumed_at", now())
        WHERE "id" = ${id}
      `;
      const challenge = challenges[0] as { user_id: string; business_id: string } | undefined;
      if (challenge) {
        await recordAudit(
          tx,
          { userId: challenge.user_id, businessId: challenge.business_id },
          fingerprint,
          "assertion_rejected",
          outcome,
        );
      }
    });
    return null;
  }

  /** Creates an action-scoped challenge and options for exactly one stored credential. */
  async function startChallenge(scope: Scope): Promise<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
    expiresAt: Date;
  }> {
    if (!isScopeValid(scope)) throw new StepUpTestServiceError("Step-up scope is invalid");
    await assertIsolatedTestDatabase(client, client);

    const eligible = await isEligibleSyntheticOwner(scope);
    if (!eligible) throw new StepUpTestServiceError("Eligible synthetic owner is unavailable");

    const session = await client`
      SELECT "id" FROM "session" WHERE "id" = ${scope.sessionId}
      AND "user_id" = ${scope.userId} AND "expires_at" > (now() AT TIME ZONE 'UTC')
      LIMIT 1
    `;
    if (session.length !== 1) throw new StepUpTestServiceError("Current session is unavailable");

    const credentials = await client`
      SELECT "credential_id", "transports", "public_key", "counter" FROM "passkey"
      WHERE "user_id" = ${scope.userId}
      ORDER BY "created_at" ASC NULLS LAST, "id" ASC
    `;
    if (credentials.length === 0) throw new StepUpTestServiceError("Passkey is unavailable");
    const credential = credentials[0] as {
      credential_id: string;
      transports: string | null;
      public_key: string;
      counter: number;
    };
    const webauthnOptions = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      timeout: CHALLENGE_LIFETIME_MS,
      allowCredentials: [
        {
          id: credential.credential_id,
          ...(credential.transports
            ? {
                transports: credential.transports
                  .split(",")
                  .filter(Boolean) as AuthenticatorTransportFuture[],
              }
            : {}),
        },
      ],
    });
    const challengeId = randomUUID();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + CHALLENGE_LIFETIME_MS);
    const fingerprint = credentialFingerprint(credential.public_key);
    await client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope.userId}, 0))`;
      const recent = await tx`
        SELECT count(*)::int AS count FROM "step_up_challenge"
        WHERE "user_id" = ${scope.userId}
          AND "created_at" > now() - ${CHALLENGE_RATE_WINDOW_MS} * interval '1 millisecond'
      `;
      if ((recent[0]?.count ?? 0) >= CHALLENGE_RATE_MAX) {
        throw new StepUpTestServiceError("Step-up challenge rate limit exceeded");
      }
      await tx`
        INSERT INTO "step_up_challenge" (
          "id", "challenge_hash", "user_id", "session_id", "business_id", "credential_id",
          "credential_fingerprint", "credential_counter", "membership_role", "action", "target_digest",
          "security_epoch", "recovery_activity_count", "created_at", "expires_at"
        ) VALUES (
          ${challengeId}, ${sha256(webauthnOptions.challenge)}, ${scope.userId}, ${scope.sessionId},
          ${scope.businessId}, ${credential.credential_id}, ${fingerprint}, ${credential.counter},
          'owner', ${scope.action},
          ${targetDigest(scope.target)}, ${eligible.security_epoch},
          (SELECT count(*)::int FROM "recovery_audit_event" WHERE "user_id" = ${scope.userId}),
          ${createdAt.toISOString()}, ${expiresAt.toISOString()}
        )
      `;
      await recordAudit(tx, scope, fingerprint, "challenge_issued", "issued");
    });
    return { challengeId, options: webauthnOptions, expiresAt };
  }

  /** Verifies a signed assertion and writes a one-use proof only after fresh DB checks. */
  async function verifyAssertion(input: {
    challengeId: string;
    scope: Scope;
    response: AuthenticationResponseJSON;
  }): Promise<{ proofId: string; expiresAt: Date } | null> {
    if (!isScopeValid(input.scope)) return null;
    await assertIsolatedTestDatabase(client, client);
    const challenge = await loadChallenge(client, input.challengeId);
    if (!challenge) return null;
    const fingerprint = credentialFingerprint(challenge.public_key);
    if (
      challenge.consumed_at ||
      challenge.expires_at_utc_ms <= Date.now() ||
      challenge.session_expires_at_utc_ms <= Date.now() ||
      challenge.phone_number_verified !== true ||
      challenge.email_verified !== false ||
      challenge.current_role !== "owner" ||
      challenge.credential_fingerprint !== fingerprint ||
      !scopeMatches(challenge, input.scope) ||
      input.response.id !== challenge.credential_id ||
      input.response.rawId !== input.response.id ||
      input.response.type !== "public-key"
    ) {
      return consumeChallengeFailure(input.challengeId, input.scope, fingerprint, "stale");
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: (receivedChallenge) =>
          challengeMatches(receivedChallenge, challenge.challenge_hash),
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        expectedType: "webauthn.get",
        requireUserVerification: true,
        advancedFIDOConfig: { userVerification: "required" },
        credential: {
          id: challenge.credential_id,
          publicKey: Buffer.from(challenge.public_key, "base64"),
          counter: challenge.credential_counter,
          transports: challenge.transports?.split(",").filter(Boolean) as never,
        },
      });
    } catch {
      return consumeChallengeFailure(input.challengeId, input.scope, fingerprint, "rejected");
    }
    if (
      !verification.verified ||
      !verification.authenticationInfo.userVerified ||
      verification.authenticationInfo.credentialID !== challenge.credential_id ||
      verification.authenticationInfo.origin !== ORIGIN ||
      verification.authenticationInfo.rpID !== RP_ID
    ) {
      return consumeChallengeFailure(input.challengeId, input.scope, fingerprint, "rejected");
    }

    const proofId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + PROOF_LIFETIME_MS);
    return client.begin(async (tx) => {
      const current = await tx<Challenge[]>`
        SELECT challenge."id", challenge."challenge_hash", challenge."user_id", challenge."session_id",
          challenge."business_id", challenge."credential_id", challenge."credential_fingerprint",
          challenge."credential_counter", challenge."membership_role", challenge."action",
          challenge."target_digest", challenge."security_epoch", challenge."recovery_activity_count",
          challenge."consumed_at",
          (EXTRACT(EPOCH FROM (challenge."expires_at" AT TIME ZONE 'UTC')) * 1000)::double precision AS "expires_at_utc_ms",
          credential."public_key", credential."counter" AS "current_counter", credential."transports",
          test_identity."security_epoch" AS "current_security_epoch",
          (SELECT count(*)::int FROM "recovery_audit_event" audit
            WHERE audit."user_id" = challenge."user_id") AS "current_recovery_activity_count",
          (EXTRACT(EPOCH FROM (auth_session."expires_at" AT TIME ZONE 'UTC')) * 1000)::double precision AS "session_expires_at_utc_ms",
          account_user."phone_number_verified", account_user."email_verified",
          membership."role" AS "current_role"
        FROM "step_up_challenge" challenge
        INNER JOIN "step_up_test_identity" test_identity
          ON test_identity."user_id" = challenge."user_id"
        INNER JOIN "user" account_user ON account_user."id" = challenge."user_id"
        INNER JOIN "session" auth_session
          ON auth_session."id" = challenge."session_id"
          AND auth_session."user_id" = challenge."user_id"
        INNER JOIN "member" membership
          ON membership."organization_id" = challenge."business_id"
          AND membership."user_id" = challenge."user_id"
        INNER JOIN "passkey" credential
          ON credential."credential_id" = challenge."credential_id"
          AND credential."user_id" = challenge."user_id"
        WHERE challenge."id" = ${input.challengeId}
          AND challenge."consumed_at" IS NULL
        FOR UPDATE OF challenge, test_identity, auth_session, credential
      `;
      const row = current[0] as Challenge | undefined;
      const currentActivityCount = row?.current_recovery_activity_count ?? 0;
      const stateIsCurrent = Boolean(
        row &&
          row.expires_at_utc_ms > issuedAt.getTime() &&
          row.session_expires_at_utc_ms > issuedAt.getTime() &&
          row.phone_number_verified === true &&
          row.email_verified === false &&
          row.current_role === "owner" &&
          row.current_counter === challenge.credential_counter &&
          row.current_security_epoch === challenge.security_epoch &&
          row.recovery_activity_count === currentActivityCount &&
          credentialFingerprint(row.public_key) === challenge.credential_fingerprint &&
          scopeMatches(row, input.scope),
      );
      if (!row) return null;

      await tx`
        UPDATE "step_up_challenge" SET "consumed_at" = ${issuedAt.toISOString()}
        WHERE "id" = ${input.challengeId} AND "consumed_at" IS NULL
      `;
      if (!stateIsCurrent) {
        await recordAudit(tx, input.scope, fingerprint, "assertion_rejected", "stale");
        return null;
      }

      const newCounter = verification.authenticationInfo.newCounter;
      if (row.credential_counter > 0 && newCounter <= row.credential_counter) {
        await recordAudit(tx, input.scope, fingerprint, "assertion_rejected", "rejected");
        return null;
      }
      const counterUpdate = await tx`
        UPDATE "passkey" SET "counter" = ${newCounter}
        WHERE "credential_id" = ${row.credential_id} AND "user_id" = ${row.user_id}
          AND "counter" = ${row.credential_counter}
        RETURNING "id"
      `;
      if (counterUpdate.length !== 1) {
        await recordAudit(tx, input.scope, fingerprint, "assertion_rejected", "replayed");
        return null;
      }
      await tx`
        INSERT INTO "step_up_proof" (
          "id", "challenge_id", "user_id", "session_id", "business_id", "credential_id",
          "credential_fingerprint", "credential_counter", "membership_role", "action",
          "target_digest", "security_epoch", "recovery_activity_count", "issued_at", "expires_at"
        ) VALUES (
          ${proofId}, ${row.id}, ${row.user_id}, ${row.session_id}, ${row.business_id},
          ${row.credential_id}, ${fingerprint}, ${newCounter}, ${row.current_role}, ${row.action},
          ${row.target_digest}, ${row.security_epoch}, ${currentActivityCount},
          ${issuedAt.toISOString()}, ${expiresAt.toISOString()}
        )
      `;
      await recordAudit(tx, input.scope, fingerprint, "assertion_verified", "verified");
      return { proofId, expiresAt };
    });
  }

  /** Consume proof using a caller-owned transaction from this isolated test database. */
  async function consumeProofInTransaction(
    tx: TransactionSql,
    proofId: string,
    scope: Scope,
  ): Promise<ConsumedStepUpTestProof | null> {
    if (!isScopeValid(scope)) return null;
    await assertIsolatedTestDatabase(client, tx);
    const digest = targetDigest(scope.target);
    // Match C3b's per-user serialization so recovery-state changes cannot
    // race evidence redemption.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${scope.userId}, 0))`;
    const rows = await tx`
        SELECT proof."id", proof."challenge_id", proof."user_id", proof."session_id", proof."business_id",
          proof."credential_id", proof."credential_fingerprint", proof."credential_counter",
          proof."membership_role", proof."action", proof."target_digest", proof."security_epoch",
          proof."recovery_activity_count", proof."consumed_at",
          (EXTRACT(EPOCH FROM (proof."issued_at" AT TIME ZONE 'UTC')) * 1000)::double precision AS "issued_at_utc_ms",
          (EXTRACT(EPOCH FROM (proof."expires_at" AT TIME ZONE 'UTC')) * 1000)::double precision AS "expires_at_utc_ms",
          credential."public_key", credential."counter" AS "current_counter",
          identity."security_epoch" AS "current_security_epoch",
          (EXTRACT(EPOCH FROM (auth_session."expires_at" AT TIME ZONE 'UTC')) * 1000)::double precision AS "session_expires_at_utc_ms",
          account_user."phone_number_verified", account_user."email_verified",
          membership."role" AS "current_role",
          (SELECT count(*)::int FROM "recovery_audit_event" audit
            WHERE audit."user_id" = proof."user_id") AS "current_recovery_activity_count"
        FROM "step_up_proof" proof
        INNER JOIN "step_up_test_identity" identity
          ON identity."user_id" = proof."user_id" AND identity."designation" = 'synthetic_fixture'
        INNER JOIN "user" account_user ON account_user."id" = proof."user_id"
        INNER JOIN "session" auth_session
          ON auth_session."id" = proof."session_id" AND auth_session."user_id" = proof."user_id"
        INNER JOIN "member" membership
          ON membership."organization_id" = proof."business_id"
          AND membership."user_id" = proof."user_id"
        INNER JOIN "passkey" credential
          ON credential."credential_id" = proof."credential_id"
          AND credential."user_id" = proof."user_id"
        WHERE proof."id" = ${proofId} AND proof."user_id" = ${scope.userId}
        FOR UPDATE OF proof, identity, auth_session, membership, credential
      `;
    const proof = rows[0] as
      | (Record<string, unknown> & {
          id: string;
          user_id: string;
          business_id: string;
          session_id: string;
          credential_fingerprint: string;
          credential_counter: number;
          membership_role: string;
          action: string;
          target_digest: string;
          security_epoch: number;
          recovery_activity_count: number;
          issued_at_utc_ms: number;
          expires_at_utc_ms: number;
          consumed_at: Date | string | null;
          public_key: string;
          current_counter: number;
          current_security_epoch: number;
          session_expires_at_utc_ms: number;
          phone_number_verified: boolean | null;
          email_verified: boolean;
          current_role: string;
          current_recovery_activity_count: number;
        })
      | undefined;
    const valid = Boolean(
      proof &&
        proof.session_id === scope.sessionId &&
        proof.business_id === scope.businessId &&
        proof.action === scope.action &&
        proof.target_digest === digest &&
        proof.consumed_at === null &&
        proof.issued_at_utc_ms <= Date.now() &&
        proof.issued_at_utc_ms >= Date.now() - PROOF_LIFETIME_MS &&
        proof.expires_at_utc_ms > Date.now() &&
        proof.session_expires_at_utc_ms > Date.now() &&
        proof.phone_number_verified === true &&
        proof.email_verified === false &&
        proof.current_role === proof.membership_role &&
        proof.current_role === "owner" &&
        proof.current_counter === proof.credential_counter &&
        proof.current_security_epoch === proof.security_epoch &&
        proof.current_recovery_activity_count === proof.recovery_activity_count &&
        credentialFingerprint(proof.public_key) === proof.credential_fingerprint,
    );
    if (proof && valid) {
      const consumed = await tx`
          UPDATE "step_up_proof" SET "consumed_at" = now()
          WHERE "id" = ${proof.id} AND "consumed_at" IS NULL
          RETURNING "id"
        `;
      if (consumed.length !== 1) return null;
      await recordAudit(
        tx,
        { userId: proof.user_id, businessId: proof.business_id },
        proof.credential_fingerprint,
        "proof_consumed",
        "consumed",
      );
      return {
        userId: proof.user_id,
        businessId: proof.business_id,
        action: proof.action,
        targetDigest: proof.target_digest,
      };
    }
    if (proof) {
      await recordAudit(
        tx,
        { userId: proof.user_id, businessId: proof.business_id },
        proof.credential_fingerprint,
        "proof_consumed",
        proof.consumed_at ? "replayed" : "stale",
      );
    }
    return null;
  }

  /** Atomically consumes proof only for its original live session and exact action target. */
  async function consumeProof(proofId: string, scope: Scope): Promise<boolean> {
    if (!isScopeValid(scope)) return false;
    await assertIsolatedTestDatabase(client, client);
    return client.begin(
      async (tx) => (await consumeProofInTransaction(tx, proofId, scope)) !== null,
    );
  }

  /** Test hook simulating a security-event epoch change; not a production API. */
  async function advanceSyntheticSecurityEpoch(userId: string) {
    await assertIsolatedTestDatabase(client, client);
    const rows = await client`
      UPDATE "step_up_test_identity" SET "security_epoch" = "security_epoch" + 1
      WHERE "user_id" = ${userId} AND "designation" = 'synthetic_fixture'
      RETURNING "security_epoch"
    `;
    return rows[0]?.security_epoch ?? null;
  }

  const service = {
    startChallenge,
    verifyAssertion,
    consumeProof,
    consumeProofInTransaction,
    advanceSyntheticSecurityEpoch,
  };
  stepUpTestServiceClients.set(service, client);
  return service;
}
