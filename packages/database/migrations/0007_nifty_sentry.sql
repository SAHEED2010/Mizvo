CREATE TABLE "recovery_test_identity" (
	"user_id" text PRIMARY KEY NOT NULL,
	"designation" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_test_identity_designation" CHECK ("recovery_test_identity"."designation" = 'synthetic_fixture')
);
--> statement-breakpoint
ALTER TABLE "recovery_test_identity" ADD CONSTRAINT "recovery_test_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;