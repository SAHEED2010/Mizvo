import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  assertOwnerRemains,
  requireBusinessMembership,
  requireBusinessPermission,
} from "./authorization.js";

describe("business authorization policy", () => {
  const memberships = [
    { organizationId: "business-a", userId: "user-1", role: "staff" },
    { organizationId: "business-b", userId: "user-1", role: "owner" },
  ];

  it("keeps each user's role scoped to the requested business", () => {
    expect(requireBusinessMembership(memberships[0] ?? null, "user-1", "business-a").role).toBe(
      "staff",
    );
    expect(() => requireBusinessMembership(memberships[1] ?? null, "user-1", "business-a")).toThrow(
      AuthorizationError,
    );
    expect(() => requireBusinessMembership(memberships[0] ?? null, "user-2", "business-a")).toThrow(
      AuthorizationError,
    );
  });

  it("rejects unknown or inherited role names", () => {
    expect(() =>
      requireBusinessMembership(
        { organizationId: "business-a", userId: "user-1", role: "toString" },
        "user-1",
        "business-a",
      ),
    ).toThrow(AuthorizationError);
  });

  it("does not give staff owner permissions from another business", () => {
    const context = requireBusinessMembership(memberships[0] ?? null, "user-1", "business-a");
    expect(() => requireBusinessPermission(context, "members:manage")).toThrow(AuthorizationError);
    expect(() => requireBusinessPermission(context, "finance:write-operational")).not.toThrow();
  });

  it("blocks demoting or removing the last owner", () => {
    expect(() => assertOwnerRemains(memberships, "business-b", "user-1", "manager")).toThrow(
      "A business must retain at least one owner",
    );
    expect(() => assertOwnerRemains(memberships, "business-b", "user-1", null)).toThrow(
      "A business must retain at least one owner",
    );
  });

  it("allows owner changes when a second owner remains", () => {
    expect(() =>
      assertOwnerRemains(
        [...memberships, { organizationId: "business-b", userId: "user-2", role: "owner" }],
        "business-b",
        "user-1",
        "manager",
      ),
    ).not.toThrow();
  });
});
