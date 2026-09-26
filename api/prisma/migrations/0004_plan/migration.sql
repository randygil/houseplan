ALTER TABLE "transactions" ADD COLUMN     "planEntryId" INTEGER;

-- CreateTable
CREATE TABLE "plan_items" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'bill',
    "amount" DECIMAL(24,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "dueDay" INTEGER,
    "dueDayEnd" INTEGER,
    "remindDays" INTEGER NOT NULL DEFAULT 1,
    "categoryId" INTEGER,
    "accountId" INTEGER,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_entries" (
    "id" SERIAL NOT NULL,
    "itemId" INTEGER NOT NULL,
    "month" DATE NOT NULL,
    "planned" DECIMAL(24,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "dueFrom" DATE,
    "dueTo" DATE,
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "remindedOn" DATE,
    "snoozeUntil" DATE,

    CONSTRAINT "plan_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_entries_month_idx" ON "plan_entries"("month");

-- CreateIndex
CREATE UNIQUE INDEX "plan_entries_itemId_month_key" ON "plan_entries"("itemId", "month");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_planEntryId_fkey" FOREIGN KEY ("planEntryId") REFERENCES "plan_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_entries" ADD CONSTRAINT "plan_entries_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "plan_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

