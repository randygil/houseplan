-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "accounts" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "openingBalance" DECIMAL(24,8) NOT NULL DEFAULT 0,
    "openingAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReconciledBalance" DECIMAL(24,8),
    "lastReconciledAt" TIMESTAMPTZ,
    "payMethodAliases" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "raw_events" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ NOT NULL,
    "ingestedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ,

    CONSTRAINT "raw_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" INTEGER,
    "emoji" TEXT,
    "budgetMonthlyUsd" DECIMAL(24,8),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bags" (
    "id" SERIAL NOT NULL,
    "p2pTransactionId" INTEGER NOT NULL,
    "accountId" INTEGER NOT NULL,
    "amountVes" DECIMAL(24,8) NOT NULL,
    "remainingVes" DECIMAL(24,8) NOT NULL,
    "rate" DECIMAL(24,8) NOT NULL,
    "openedAt" TIMESTAMPTZ NOT NULL,
    "closedAt" TIMESTAMPTZ,
    "muted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "bags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "occurredAt" TIMESTAMPTZ NOT NULL,
    "amount" DECIMAL(24,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "amountUsd" DECIMAL(24,8),
    "fxRate" DECIMAL(24,8),
    "fxSource" TEXT,
    "fromAccountId" INTEGER,
    "toAccountId" INTEGER,
    "toAmount" DECIMAL(24,8),
    "categoryId" INTEGER,
    "merchant" TEXT,
    "note" TEXT,
    "justified" BOOLEAN NOT NULL DEFAULT false,
    "justification" TEXT,
    "source" TEXT NOT NULL,
    "rawEventId" INTEGER,
    "bagId" INTEGER,
    "confidence" DOUBLE PRECISION,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transaction_versions" (
    "id" SERIAL NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transaction_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bag_allocations" (
    "bagId" INTEGER NOT NULL,
    "transactionId" INTEGER NOT NULL,
    "amountVes" DECIMAL(24,8) NOT NULL,

    CONSTRAINT "bag_allocations_pkey" PRIMARY KEY ("bagId","transactionId")
);

-- CreateTable
CREATE TABLE "merchant_rules" (
    "id" SERIAL NOT NULL,
    "pattern" TEXT NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "accountId" INTEGER,
    "hits" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "merchant_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_snapshots" (
    "id" SERIAL NOT NULL,
    "takenAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wallet" TEXT NOT NULL DEFAULT 'funding',
    "balances" JSONB NOT NULL,

    CONSTRAINT "wallet_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "date" DATE NOT NULL,
    "source" TEXT NOT NULL,
    "vesPerUsd" DECIMAL(24,8) NOT NULL,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("date","source")
);

-- CreateTable
CREATE TABLE "pending_prompts" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" INTEGER,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "dueAt" TIMESTAMPTZ NOT NULL,
    "sentAt" TIMESTAMPTZ,
    "answeredAt" TIMESTAMPTZ,
    "cancelledAt" TIMESTAMPTZ,
    "telegramMessageId" BIGINT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pending_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_turns" (
    "id" SERIAL NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "txIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embeddings" (
    "id" SERIAL NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(384) NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "web_sessions" (
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "web_sessions_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "raw_events_source_externalId_key" ON "raw_events"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "bags_p2pTransactionId_key" ON "bags"("p2pTransactionId");

-- CreateIndex
CREATE INDEX "transactions_occurredAt_idx" ON "transactions"("occurredAt");

-- CreateIndex
CREATE INDEX "transactions_status_type_idx" ON "transactions"("status", "type");

-- CreateIndex
CREATE UNIQUE INDEX "merchant_rules_pattern_key" ON "merchant_rules"("pattern");

-- CreateIndex
CREATE INDEX "wallet_snapshots_wallet_takenAt_idx" ON "wallet_snapshots"("wallet", "takenAt");

-- CreateIndex
CREATE INDEX "pending_prompts_dueAt_idx" ON "pending_prompts"("dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "embeddings_ownerType_ownerId_key" ON "embeddings"("ownerType", "ownerId");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bags" ADD CONSTRAINT "bags_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_fromAccountId_fkey" FOREIGN KEY ("fromAccountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_rawEventId_fkey" FOREIGN KEY ("rawEventId") REFERENCES "raw_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bagId_fkey" FOREIGN KEY ("bagId") REFERENCES "bags"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transaction_versions" ADD CONSTRAINT "transaction_versions_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bag_allocations" ADD CONSTRAINT "bag_allocations_bagId_fkey" FOREIGN KEY ("bagId") REFERENCES "bags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bag_allocations" ADD CONSTRAINT "bag_allocations_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_rules" ADD CONSTRAINT "merchant_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_rules" ADD CONSTRAINT "merchant_rules_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ponytail: Prisma can't express HNSW; kept in the migration by hand
CREATE INDEX "embeddings_hnsw" ON "embeddings" USING hnsw ("embedding" vector_cosine_ops);
