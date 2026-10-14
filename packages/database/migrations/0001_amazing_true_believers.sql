CREATE UNIQUE INDEX "member_organization_user_unique" ON "member" USING btree ("organization_id","user_id");--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_role_allowed" CHECK ("member"."role" IN ('owner', 'manager', 'staff', 'viewer'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "mizvo_preserve_last_owner"() RETURNS trigger AS $$
DECLARE
	remaining_owners integer;
BEGIN
	IF OLD."role" = 'owner' AND (TG_OP = 'DELETE' OR NEW."role" <> 'owner') THEN
		-- Serialize owner removals/demotions for one business to prevent races.
		PERFORM 1 FROM "organization" WHERE "id" = OLD."organization_id" FOR UPDATE;
		SELECT count(*) INTO remaining_owners
		FROM "member"
		WHERE "organization_id" = OLD."organization_id"
			AND "role" = 'owner'
			AND "id" <> OLD."id";
		IF remaining_owners = 0 THEN
			RAISE EXCEPTION 'A business must retain at least one owner'
				USING ERRCODE = 'check_violation';
		END IF;
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "member_preserve_last_owner"
BEFORE UPDATE OF "role" OR DELETE ON "member"
FOR EACH ROW EXECUTE FUNCTION "mizvo_preserve_last_owner"();
