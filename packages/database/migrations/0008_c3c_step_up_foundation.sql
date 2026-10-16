CREATE TABLE "step_up_challenge" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"business_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"membership_role" text NOT NULL,
	"action" text NOT NULL,
	"target_digest" text NOT NULL,
	"security_epoch" integer NOT NULL,
	"recovery_activity_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "step_up_challenge_challenge_hash_unique" UNIQUE("challenge_hash"),
	CONSTRAINT "step_up_challenge_hash_format" CHECK ("step_up_challenge"."challenge_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "step_up_challenge_credential_fingerprint_format" CHECK ("step_up_challenge"."credential_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "step_up_challenge_target_digest_format" CHECK ("step_up_challenge"."target_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "step_up_challenge_action_allowed" CHECK ("step_up_challenge"."action" IN ('business.invitation.create', 'business.member.remove', 'business.member.role_change')),
	CONSTRAINT "step_up_challenge_role_allowed" CHECK ("step_up_challenge"."membership_role" IN ('owner', 'manager', 'staff', 'viewer')),
	CONSTRAINT "step_up_challenge_epoch_positive" CHECK ("step_up_challenge"."security_epoch" > 0),
	CONSTRAINT "step_up_challenge_recovery_count_nonnegative" CHECK ("step_up_challenge"."recovery_activity_count" >= 0),
	CONSTRAINT "step_up_challenge_expiry_window" CHECK ("step_up_challenge"."expires_at" > "step_up_challenge"."created_at" AND "step_up_challenge"."expires_at" <= "step_up_challenge"."created_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "step_up_proof" (
	"id" text PRIMARY KEY NOT NULL,
	"challenge_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"business_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"credential_fingerprint" text NOT NULL,
	"credential_counter" integer NOT NULL,
	"membership_role" text NOT NULL,
	"action" text NOT NULL,
	"target_digest" text NOT NULL,
	"security_epoch" integer NOT NULL,
	"recovery_activity_count" integer NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "step_up_proof_challenge_id_unique" UNIQUE("challenge_id"),
	CONSTRAINT "step_up_proof_credential_fingerprint_format" CHECK ("step_up_proof"."credential_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "step_up_proof_counter_nonnegative" CHECK ("step_up_proof"."credential_counter" >= 0),
	CONSTRAINT "step_up_proof_target_digest_format" CHECK ("step_up_proof"."target_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "step_up_proof_action_allowed" CHECK ("step_up_proof"."action" IN ('business.invitation.create', 'business.member.remove', 'business.member.role_change')),
	CONSTRAINT "step_up_proof_role_allowed" CHECK ("step_up_proof"."membership_role" IN ('owner', 'manager', 'staff', 'viewer')),
	CONSTRAINT "step_up_proof_epoch_positive" CHECK ("step_up_proof"."security_epoch" > 0),
	CONSTRAINT "step_up_proof_recovery_count_nonnegative" CHECK ("step_up_proof"."recovery_activity_count" >= 0),
	CONSTRAINT "step_up_proof_expiry_window" CHECK ("step_up_proof"."expires_at" > "step_up_proof"."issued_at" AND "step_up_proof"."expires_at" <= "step_up_proof"."issued_at" + interval '10 minutes')
);
--> statement-breakpoint
CREATE TABLE "step_up_test_audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"business_id" text,
	"credential_fingerprint" text,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "step_up_test_audit_event_allowed" CHECK ("step_up_test_audit_event"."event" IN ('challenge_issued', 'assertion_verified', 'assertion_rejected', 'proof_consumed')),
	CONSTRAINT "step_up_test_audit_outcome_allowed" CHECK ("step_up_test_audit_event"."outcome" IN ('issued', 'verified', 'rejected', 'consumed', 'replayed', 'stale')),
	CONSTRAINT "step_up_test_audit_fingerprint_format" CHECK ("step_up_test_audit_event"."credential_fingerprint" IS NULL OR "step_up_test_audit_event"."credential_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "step_up_test_identity" (
	"user_id" text PRIMARY KEY NOT NULL,
	"designation" text NOT NULL,
	"security_epoch" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "step_up_test_identity_designation" CHECK ("step_up_test_identity"."designation" = 'synthetic_fixture'),
	CONSTRAINT "step_up_test_identity_epoch_positive" CHECK ("step_up_test_identity"."security_epoch" > 0)
);
--> statement-breakpoint
ALTER TABLE "step_up_challenge" ADD CONSTRAINT "step_up_challenge_user_id_step_up_test_identity_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."step_up_test_identity"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_challenge" ADD CONSTRAINT "step_up_challenge_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_challenge" ADD CONSTRAINT "step_up_challenge_business_id_organization_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_challenge" ADD CONSTRAINT "step_up_challenge_credential_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."passkey"("credential_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_proof" ADD CONSTRAINT "step_up_proof_challenge_id_step_up_challenge_id_fk" FOREIGN KEY ("challenge_id") REFERENCES "public"."step_up_challenge"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_proof" ADD CONSTRAINT "step_up_proof_user_id_step_up_test_identity_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."step_up_test_identity"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_proof" ADD CONSTRAINT "step_up_proof_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_proof" ADD CONSTRAINT "step_up_proof_business_id_organization_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_proof" ADD CONSTRAINT "step_up_proof_credential_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."passkey"("credential_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_test_audit_event" ADD CONSTRAINT "step_up_test_audit_event_user_id_step_up_test_identity_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."step_up_test_identity"("user_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_test_audit_event" ADD CONSTRAINT "step_up_test_audit_event_business_id_organization_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_up_test_identity" ADD CONSTRAINT "step_up_test_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "step_up_challenge_user_created_idx" ON "step_up_challenge" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "step_up_challenge_session_idx" ON "step_up_challenge" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "step_up_proof_user_scope_idx" ON "step_up_proof" USING btree ("user_id","session_id","business_id","action");--> statement-breakpoint
CREATE INDEX "step_up_test_audit_user_time_idx" ON "step_up_test_audit_event" USING btree ("user_id","created_at");