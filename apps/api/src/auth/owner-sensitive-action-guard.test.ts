import { describe, expect, it, vi } from "vitest";
import { evaluateOwnerSensitiveAction } from "./owner-sensitive-action-guard.js";

describe("owner-sensitive action guard", () => {
  it("denies until independent recovery enrollment is implemented", async () => {
    const stepUp = { hasValidProofWithin: vi.fn(async () => true) };
    const decision = await evaluateOwnerSensitiveAction("owner-1", {
      recovery: {
        async isIndependentlyEnrolled() {
          return false;
        },
      },
      stepUp,
    });

    expect(decision).toEqual({ allowed: false, reason: "independent_recovery_required" });
    expect(stepUp.hasValidProofWithin).not.toHaveBeenCalled();
  });

  it("requires server-verified step-up proof no older than ten minutes", async () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    const hasValidProofWithin = vi.fn(async () => false);
    const decision = await evaluateOwnerSensitiveAction(
      "owner-1",
      {
        recovery: {
          async isIndependentlyEnrolled() {
            return true;
          },
        },
        stepUp: { hasValidProofWithin },
      },
      now,
    );

    expect(decision).toEqual({ allowed: false, reason: "recent_step_up_required" });
    expect(hasValidProofWithin).toHaveBeenCalledWith("owner-1", 600_000, now);
  });
});
