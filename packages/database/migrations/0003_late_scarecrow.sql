CREATE TABLE "business_audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"invitation_id" text,
	"subject_user_id" text,
	"role" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "business_audit_event_action_allowed" CHECK ("business_audit_event"."action" IN ('invitation.created', 'invitation.revoked', 'invitation.accepted')),
	CONSTRAINT "business_audit_event_role_allowed" CHECK ("business_audit_event"."role" IS NULL OR "business_audit_event"."role" IN ('manager', 'staff', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "phone_invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"recipient_phone_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp,
	"revoked_by" text,
	"revoked_at" timestamp,
	CONSTRAINT "phone_invitation_recipient_hash_format" CHECK ("phone_invitation"."recipient_phone_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "phone_invitation_token_hash_format" CHECK ("phone_invitation"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "phone_invitation_role_allowed" CHECK ("phone_invitation"."role" IN ('manager', 'staff', 'viewer')),
	CONSTRAINT "phone_invitation_status_allowed" CHECK ("phone_invitation"."status" IN ('pending', 'accepted', 'revoked')),
	CONSTRAINT "phone_invitation_lifecycle_consistent" CHECK ((
        ("phone_invitation"."status" = 'pending' AND "phone_invitation"."accepted_by" IS NULL AND "phone_invitation"."accepted_at" IS NULL AND "phone_invitation"."revoked_by" IS NULL AND "phone_invitation"."revoked_at" IS NULL)
        OR ("phone_invitation"."status" = 'accepted' AND "phone_invitation"."accepted_by" IS NOT NULL AND "phone_invitation"."accepted_at" IS NOT NULL AND "phone_invitation"."revoked_by" IS NULL AND "phone_invitation"."revoked_at" IS NULL)
        OR ("phone_invitation"."status" = 'revoked' AND "phone_invitation"."accepted_by" IS NULL AND "phone_invitation"."accepted_at" IS NULL AND "phone_invitation"."revoked_by" IS NOT NULL AND "phone_invitation"."revoked_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "business_audit_event" ADD CONSTRAINT "business_audit_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_audit_event" ADD CONSTRAINT "business_audit_event_invitation_id_phone_invitation_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."phone_invitation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_invitation" ADD CONSTRAINT "phone_invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_invitation" ADD CONSTRAINT "phone_invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_audit_event_organization_created_idx" ON "business_audit_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "business_audit_event_invitation_idx" ON "business_audit_event" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "phone_invitation_organization_status_idx" ON "phone_invitation" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "phone_invitation_token_hash_unique" ON "phone_invitation" USING btree ("token_hash");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "mizvo_prevent_business_audit_mutation"() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION 'Business audit events are append-only'
		USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "business_audit_event_append_only"
BEFORE UPDATE OR DELETE ON "business_audit_event"
FOR EACH ROW EXECUTE FUNCTION "mizvo_prevent_business_audit_mutation"();
