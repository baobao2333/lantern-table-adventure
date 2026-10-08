CREATE TABLE `adventures` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`room_code` text NOT NULL,
	`data` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`lock_token` text,
	`lock_until` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adventures_room_code_unique` ON `adventures` (`room_code`);--> statement-breakpoint
CREATE INDEX `idx_adventures_owner` ON `adventures` (`owner`);--> statement-breakpoint
CREATE TABLE `camps` (
	`hero_id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `heroes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_heroes_owner` ON `heroes` (`owner`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`adventure_id` text NOT NULL,
	`user_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memberships_user` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_memberships_adventure` ON `memberships` (`adventure_id`);