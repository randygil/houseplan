-- "Por justificar" is gone: keep what was written by folding it into the note.
UPDATE "transactions" SET "note" = CASE WHEN coalesce("note", '') = '' THEN "justification" ELSE "note" || ' · ' || "justification" END
  WHERE coalesce("justification", '') <> '';

ALTER TABLE "transactions" DROP COLUMN "justified", DROP COLUMN "justification";
