ALTER TABLE `posts` ADD COLUMN `scores` text;
--> statement-breakpoint
ALTER TABLE `posts` ADD COLUMN `score_total` real;
--> statement-breakpoint
ALTER TABLE `posts` ADD COLUMN `score_coverage` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `posts` ADD COLUMN `verified_region` text;
--> statement-breakpoint
ALTER TABLE `posts` ADD COLUMN `verified_cost` text;
--> statement-breakpoint
ALTER TABLE `posts` ADD COLUMN `verified_risk` text;
--> statement-breakpoint
ALTER TABLE `posts` ADD COLUMN `verified_conditions` text;
--> statement-breakpoint
ALTER TABLE `posts` ADD COLUMN `verified_at` text;
--> statement-breakpoint
ALTER TABLE `posts` ADD COLUMN `verified_source_url` text;
--> statement-breakpoint
ALTER TABLE `posts` ADD COLUMN `verified_status` text;
