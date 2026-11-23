ALTER TABLE "event_type" ADD COLUMN "short_code" text;--> statement-breakpoint
ALTER TABLE "event_type" ADD CONSTRAINT "event_type_short_code_unique" UNIQUE("short_code");--> statement-breakpoint
UPDATE "event_type" SET "short_code" = substr(md5(random()::text || id::text), 1, 8) WHERE "short_code" IS NULL;
