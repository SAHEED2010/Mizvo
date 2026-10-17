CREATE TABLE "protected_action_test_effect" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"business_id" text NOT NULL,
	"action" text NOT NULL,
	"target_digest" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "protected_action_test_effect_action_allowed" CHECK ("protected_action_test_effect"."action" IN ('business.invitation.create', 'business.invitation.revoke')),
	CONSTRAINT "protected_action_test_effect_target_digest_format" CHECK ("protected_action_test_effect"."target_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "protected_action_test_effect" ADD CONSTRAINT "protected_action_test_effect_user_id_step_up_test_identity_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."step_up_test_identity"("user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "protected_action_test_effect" ADD CONSTRAINT "protected_action_test_effect_business_id_organization_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "protected_action_test_effect_scope_idx" ON "protected_action_test_effect" USING btree ("user_id","business_id","action");