-- One "Binance" account instead of binance_spot + binance_funding (no-op on a fresh DB; seed creates 'binance').
UPDATE "accounts" SET "code" = 'binance', "name" = 'Binance' WHERE "code" = 'binance_funding';

UPDATE "transactions" SET "fromAccountId" = (SELECT "id" FROM "accounts" WHERE "code" = 'binance')
  WHERE "fromAccountId" = (SELECT "id" FROM "accounts" WHERE "code" = 'binance_spot');
UPDATE "transactions" SET "toAccountId" = (SELECT "id" FROM "accounts" WHERE "code" = 'binance')
  WHERE "toAccountId" = (SELECT "id" FROM "accounts" WHERE "code" = 'binance_spot');
UPDATE "merchant_rules" SET "accountId" = (SELECT "id" FROM "accounts" WHERE "code" = 'binance')
  WHERE "accountId" = (SELECT "id" FROM "accounts" WHERE "code" = 'binance_spot');
UPDATE "bags" SET "accountId" = (SELECT "id" FROM "accounts" WHERE "code" = 'binance')
  WHERE "accountId" = (SELECT "id" FROM "accounts" WHERE "code" = 'binance_spot');

-- spot<->funding transfers are now Binance->Binance: meaningless
UPDATE "transactions" SET "status" = 'void' WHERE "type" = 'transfer' AND "fromAccountId" = "toAccountId";

DELETE FROM "accounts" WHERE "code" = 'binance_spot';
