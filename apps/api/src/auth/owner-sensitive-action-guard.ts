export interface IndependentRecoveryEnrollmentVerifier {
  isIndependentlyEnrolled(userId: string): Promise<boolean>;
}

export interface RecentStepUpVerifier {
  hasValidProofWithin(userId: string, maximumAgeMs: number, now: Date): Promise<boolean>;
}

export type OwnerSensitiveActionDecision =
  | { allowed: true }
  | { allowed: false; reason: "independent_recovery_required" | "recent_step_up_required" };

const C3_NOT_IMPLEMENTED: {
  recovery: IndependentRecoveryEnrollmentVerifier;
  stepUp: RecentStepUpVerifier;
} = {
  recovery: {
    async isIndependentlyEnrolled() {
      return false;
    },
  },
  stepUp: {
    async hasValidProofWithin() {
      return false;
    },
  },
};

export async function evaluateOwnerSensitiveAction(
  userId: string,
  evidence: {
    recovery: IndependentRecoveryEnrollmentVerifier;
    stepUp: RecentStepUpVerifier;
  },
  now = new Date(),
): Promise<OwnerSensitiveActionDecision> {
  if (!(await evidence.recovery.isIndependentlyEnrolled(userId))) {
    return { allowed: false, reason: "independent_recovery_required" };
  }
  if (!(await evidence.stepUp.hasValidProofWithin(userId, 10 * 60 * 1000, now))) {
    return { allowed: false, reason: "recent_step_up_required" };
  }
  return { allowed: true };
}

/** Production boundary. C3 has no evidence source, so this always fails closed. */
export function currentOwnerSensitiveActionDecision(
  userId: string,
  now = new Date(),
): Promise<OwnerSensitiveActionDecision> {
  return evaluateOwnerSensitiveAction(userId, C3_NOT_IMPLEMENTED, now);
}
