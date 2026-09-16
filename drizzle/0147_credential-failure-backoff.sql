CREATE TABLE "credential_failures" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone NOT NULL,
	"retry_at" timestamp with time zone NOT NULL,
	"bypass_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "credential_failures_subject_idx" ON "credential_failures" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "credential_failures_last_failure_idx" ON "credential_failures" USING btree ("last_failure_at");