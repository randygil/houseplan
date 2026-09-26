-- "Solo registro": the money moved (balances) but it isn't spending (totals, plan, summaries).
ALTER TABLE "transactions" ADD COLUMN "excluded" BOOLEAN NOT NULL DEFAULT false;
