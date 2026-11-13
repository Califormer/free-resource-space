ALTER TABLE posts ADD COLUMN category TEXT NOT NULL DEFAULT 'AI 应用试用';
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN quota TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN claim_url TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN claim_note TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN deadline INTEGER;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN deadline_text TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN region TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN last_verified TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN conditions TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN cost_note TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN risk_note TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN raw_ref TEXT;
--> statement-breakpoint
ALTER TABLE posts ADD COLUMN vendor TEXT;
