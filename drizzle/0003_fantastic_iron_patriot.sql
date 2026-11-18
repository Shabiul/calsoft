CREATE TABLE "routing_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email" text,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routing_submission" ADD CONSTRAINT "routing_submission_form_id_routing_form_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."routing_form"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routing_sub_form_idx" ON "routing_submission" USING btree ("form_id","created_at");