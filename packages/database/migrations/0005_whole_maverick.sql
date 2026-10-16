CREATE TABLE "recovery_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_attempt_user_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "recovery_attempt_purpose_test_only" CHECK ("recovery_attempt"."purpose" = 'synthetic_test'),
	CONSTRAINT "recovery_attempt_outcome_allowed" CHECK ("recovery_attempt"."outcome" IN ('pending', 'invalid_proof', 'invalid_code', 'rate_limited', 'redeemed', 'replay', 'key_unavailable'))
);
--> statement-breakpoint
CREATE TABLE "recovery_audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"attempt_id" text,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_audit_event_allowed" CHECK ("recovery_audit_event"."event" IN ('code_set_issued', 'redemption_attempted', 'capability_used', 'code_set_revoked')),
	CONSTRAINT "recovery_audit_outcome_allowed" CHECK ("recovery_audit_event"."outcome" IN ('issued', 'invalid_proof', 'invalid_code', 'rate_limited', 'redeemed', 'replay', 'used', 'revoked', 'key_unavailable'))
);
--> statement-breakpoint
CREATE TABLE "recovery_capability" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"purpose" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_capability_purpose_test_only" CHECK ("recovery_capability"."purpose" = 'synthetic_test'),
	CONSTRAINT "recovery_capability_scope_test_only" CHECK ("recovery_capability"."scope" = 'recovery_state_only')
);
--> statement-breakpoint
CREATE TABLE "recovery_code" (
	"id" text PRIMARY KEY NOT NULL,
	"set_id" text NOT NULL,
	"user_id" text NOT NULL,
	"verifier" text NOT NULL,
	"key_version" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"consumed_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "recovery_code_verifier_format" CHECK ("recovery_code"."verifier" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "recovery_code_set" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"provenance" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	CONSTRAINT "recovery_code_set_user_id_unique" UNIQUE("user_id","id"),
	CONSTRAINT "recovery_code_set_epoch_positive" CHECK ("recovery_code_set"."epoch" > 0),
	CONSTRAINT "recovery_code_set_provenance_test_only" CHECK ("recovery_code_set"."provenance" = 'synthetic_test')
);
--> statement-breakpoint
ALTER TABLE "recovery_attempt" ADD CONSTRAINT "recovery_attempt_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_audit_event" ADD CONSTRAINT "recovery_audit_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_capability" ADD CONSTRAINT "recovery_capability_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_capability" ADD CONSTRAINT "recovery_capability_user_attempt_fk" FOREIGN KEY ("user_id","attempt_id") REFERENCES "public"."recovery_attempt"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_code" ADD CONSTRAINT "recovery_code_user_set_fk" FOREIGN KEY ("user_id","set_id") REFERENCES "public"."recovery_code_set"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_code_set" ADD CONSTRAINT "recovery_code_set_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recovery_attempt_user_time_idx" ON "recovery_attempt" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "recovery_audit_user_time_idx" ON "recovery_audit_event" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_capability_attempt_unique" ON "recovery_capability" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "recovery_capability_user_expiry_idx" ON "recovery_capability" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_code_verifier_unique" ON "recovery_code" USING btree ("verifier");--> statement-breakpoint
CREATE INDEX "recovery_code_user_set_state_idx" ON "recovery_code" USING btree ("user_id","set_id","consumed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_code_set_user_epoch_unique" ON "recovery_code_set" USING btree ("user_id","epoch");--> statement-breakpoint
CREATE INDEX "recovery_code_set_user_active_idx" ON "recovery_code_set" USING btree ("user_id","revoked_at");