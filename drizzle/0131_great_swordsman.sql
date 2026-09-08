ALTER TABLE "characters" ADD COLUMN "authoring_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE FUNCTION "bump_character_authoring_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF ROW(NEW."name", NEW."profile", NEW."tags") IS DISTINCT FROM ROW(OLD."name", OLD."profile", OLD."tags") THEN
		NEW."authoring_revision" := OLD."authoring_revision" + 1;
	ELSE
		NEW."authoring_revision" := OLD."authoring_revision";
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "characters_authoring_revision_bump"
BEFORE UPDATE ON "characters"
FOR EACH ROW
EXECUTE FUNCTION "bump_character_authoring_revision"();
