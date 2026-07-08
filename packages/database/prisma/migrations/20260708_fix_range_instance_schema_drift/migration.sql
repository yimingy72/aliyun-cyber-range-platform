ALTER TABLE "RangeInstance"
ADD COLUMN IF NOT EXISTS "name" TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'RangeInstance'
      AND column_name = 'templateNameSnapshot'
  ) THEN
    EXECUTE $sql$
      UPDATE "RangeInstance"
      SET "name" = COALESCE(
        NULLIF(BTRIM("name"), ''),
        NULLIF(BTRIM("templateNameSnapshot"), ''),
        'range-instance-' || LEFT("id", 8)
      )
      WHERE "name" IS NULL OR BTRIM("name") = ''
    $sql$;
  ELSE
    EXECUTE $sql$
      UPDATE "RangeInstance"
      SET "name" = COALESCE(
        NULLIF(BTRIM("name"), ''),
        'range-instance-' || LEFT("id", 8)
      )
      WHERE "name" IS NULL OR BTRIM("name") = ''
    $sql$;
  END IF;
END $$;

ALTER TABLE "RangeInstance"
ALTER COLUMN "name" SET NOT NULL;

DO $$
DECLARE
  legacy_constraint_name TEXT;
BEGIN
  FOR legacy_constraint_name IN
    SELECT DISTINCT con.conname
    FROM pg_constraint con
    JOIN pg_class rel
      ON rel.oid = con.conrelid
    JOIN pg_namespace nsp
      ON nsp.oid = rel.relnamespace
    JOIN unnest(con.conkey) AS conkey(attnum)
      ON TRUE
    JOIN pg_attribute attr
      ON attr.attrelid = rel.oid
     AND attr.attnum = conkey.attnum
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'RangeInstance'
      AND con.contype = 'f'
      AND attr.attname IN ('competitionId', 'teamId')
  LOOP
    EXECUTE format('ALTER TABLE "RangeInstance" DROP CONSTRAINT IF EXISTS %I', legacy_constraint_name);
  END LOOP;
END $$;

DROP INDEX IF EXISTS "RangeInstance_competitionId_idx";
DROP INDEX IF EXISTS "RangeInstance_teamId_idx";

ALTER TABLE "RangeInstance"
DROP COLUMN IF EXISTS "competitionId",
DROP COLUMN IF EXISTS "teamId";
