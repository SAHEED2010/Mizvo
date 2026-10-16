import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  phoneNumber: text("phone_number").unique(),
  phoneNumberVerified: boolean("phone_number_verified"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: text("active_organization_id"),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at"),
    aaguid: text("aaguid"),
  },
  (table) => [
    index("passkey_userId_idx").on(table.userId),
    uniqueIndex("passkey_credentialID_unique").on(table.credentialID),
  ],
);

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
});

export const member = pgTable(
  "member",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("member_organizationId_idx").on(table.organizationId),
    index("member_userId_idx").on(table.userId),
    uniqueIndex("member_organization_user_unique").on(table.organizationId, table.userId),
    check("member_role_allowed", sql`${table.role} IN ('owner', 'manager', 'staff', 'viewer')`),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role"),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("invitation_organizationId_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  passkeys: many(passkey),
  members: many(member),
  invitations: many(invitation),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const passkeyRelations = relations(passkey, ({ one }) => ({
  user: one(user, {
    fields: [passkey.userId],
    references: [user.id],
  }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [member.userId],
    references: [user.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, {
    fields: [invitation.inviterId],
    references: [user.id],
  }),
}));

// Phone invitations use their own model instead of Better Auth's email-only
// invitation schema. Only the keyed recipient hash and token hash are stored.
export const phoneInvitation = pgTable(
  "phone_invitation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    recipientPhoneHash: text("recipient_phone_hash").notNull(),
    tokenHash: text("token_hash").notNull(),
    role: text("role").notNull(),
    status: text("status").default("pending").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    inviterId: text("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    acceptedBy: text("accepted_by"),
    acceptedAt: timestamp("accepted_at"),
    revokedBy: text("revoked_by"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    index("phone_invitation_organization_status_idx").on(table.organizationId, table.status),
    uniqueIndex("phone_invitation_token_hash_unique").on(table.tokenHash),
    check(
      "phone_invitation_recipient_hash_format",
      sql`${table.recipientPhoneHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("phone_invitation_token_hash_format", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("phone_invitation_role_allowed", sql`${table.role} IN ('manager', 'staff', 'viewer')`),
    check(
      "phone_invitation_status_allowed",
      sql`${table.status} IN ('pending', 'accepted', 'revoked')`,
    ),
    check(
      "phone_invitation_lifecycle_consistent",
      sql`(
        (${table.status} = 'pending' AND ${table.acceptedBy} IS NULL AND ${table.acceptedAt} IS NULL AND ${table.revokedBy} IS NULL AND ${table.revokedAt} IS NULL)
        OR (${table.status} = 'accepted' AND ${table.acceptedBy} IS NOT NULL AND ${table.acceptedAt} IS NOT NULL AND ${table.revokedBy} IS NULL AND ${table.revokedAt} IS NULL)
        OR (${table.status} = 'revoked' AND ${table.acceptedBy} IS NULL AND ${table.acceptedAt} IS NULL AND ${table.revokedBy} IS NOT NULL AND ${table.revokedAt} IS NOT NULL)
      )`,
    ),
  ],
);

export const businessAuditEvent = pgTable(
  "business_audit_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    invitationId: text("invitation_id").references(() => phoneInvitation.id, {
      onDelete: "restrict",
    }),
    subjectUserId: text("subject_user_id"),
    role: text("role"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("business_audit_event_organization_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("business_audit_event_invitation_idx").on(table.invitationId),
    check(
      "business_audit_event_action_allowed",
      sql`${table.action} IN ('invitation.created', 'invitation.revoked', 'invitation.accepted')`,
    ),
    check(
      "business_audit_event_role_allowed",
      sql`${table.role} IS NULL OR ${table.role} IN ('manager', 'staff', 'viewer')`,
    ),
  ],
);

// C3b development/test-only recovery foundation. These records are not wired
// to an HTTP handler and cannot authorize Better Auth sessions or business work.
export const recoveryTestIdentity = pgTable(
  "recovery_test_identity",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    designation: text("designation").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    check("recovery_test_identity_designation", sql`${table.designation} = 'synthetic_fixture'`),
  ],
);

export const recoveryCodeSet = pgTable(
  "recovery_code_set",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    epoch: integer("epoch").notNull(),
    provenance: text("provenance").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("recovery_code_set_user_epoch_unique").on(table.userId, table.epoch),
    unique("recovery_code_set_user_id_unique").on(table.userId, table.id),
    index("recovery_code_set_user_active_idx").on(table.userId, table.revokedAt),
    check("recovery_code_set_epoch_positive", sql`${table.epoch} > 0`),
    check("recovery_code_set_provenance_test_only", sql`${table.provenance} = 'synthetic_test'`),
  ],
);

export const recoveryCode = pgTable(
  "recovery_code",
  {
    id: text("id").primaryKey(),
    setId: text("set_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verifier: text("verifier").notNull(),
    keyVersion: text("key_version").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    consumedAt: timestamp("consumed_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    uniqueIndex("recovery_code_verifier_unique").on(table.verifier),
    index("recovery_code_user_set_state_idx").on(table.userId, table.setId, table.consumedAt),
    foreignKey({
      name: "recovery_code_user_set_fk",
      columns: [table.userId, table.setId],
      foreignColumns: [recoveryCodeSet.userId, recoveryCodeSet.id],
    }).onDelete("cascade"),
    check("recovery_code_verifier_format", sql`${table.verifier} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const recoveryAttempt = pgTable(
  "recovery_attempt",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("recovery_attempt_user_time_idx").on(table.userId, table.createdAt),
    unique("recovery_attempt_user_id_unique").on(table.userId, table.id),
    check("recovery_attempt_purpose_test_only", sql`${table.purpose} = 'synthetic_test'`),
    check(
      "recovery_attempt_outcome_allowed",
      sql`${table.outcome} IN ('pending', 'invalid_proof', 'invalid_code', 'rate_limited', 'redeemed', 'replay', 'key_unavailable')`,
    ),
  ],
);

export const recoveryCapability = pgTable(
  "recovery_capability",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id").notNull(),
    purpose: text("purpose").notNull(),
    scope: text("scope").notNull(),
    verifier: text("verifier").notNull(),
    keyVersion: text("key_version").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("recovery_capability_attempt_unique").on(table.attemptId),
    index("recovery_capability_user_expiry_idx").on(table.userId, table.expiresAt),
    foreignKey({
      name: "recovery_capability_user_attempt_fk",
      columns: [table.userId, table.attemptId],
      foreignColumns: [recoveryAttempt.userId, recoveryAttempt.id],
    }).onDelete("cascade"),
    check("recovery_capability_verifier_format", sql`${table.verifier} ~ '^[0-9a-f]{64}$'`),
    check("recovery_capability_purpose_test_only", sql`${table.purpose} = 'synthetic_test'`),
    check("recovery_capability_scope_test_only", sql`${table.scope} = 'recovery_state_only'`),
  ],
);

export const recoveryAuditEvent = pgTable(
  "recovery_audit_event",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    attemptId: text("attempt_id"),
    event: text("event").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("recovery_audit_user_time_idx").on(table.userId, table.createdAt),
    check(
      "recovery_audit_event_allowed",
      sql`${table.event} IN ('code_set_issued', 'redemption_attempted', 'capability_used', 'code_set_revoked')`,
    ),
    check(
      "recovery_audit_outcome_allowed",
      sql`${table.outcome} IN ('issued', 'invalid_proof', 'invalid_code', 'rate_limited', 'redeemed', 'replay', 'used', 'revoked', 'key_unavailable')`,
    ),
  ],
);
