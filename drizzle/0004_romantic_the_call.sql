CREATE TABLE "payment_webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plan_provider_price" (
	"plan_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_price_id" text NOT NULL,
	CONSTRAINT "plan_provider_price_plan_id_provider_pk" PRIMARY KEY("plan_id","provider")
);
--> statement-breakpoint
ALTER TABLE "plan_provider_price" ADD CONSTRAINT "plan_provider_price_plan_id_subscription_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_event_uq" ON "payment_webhook_event" USING btree ("provider","event_id");